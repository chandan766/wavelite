// Cloudflare Pages Function for WebRTC signaling
// Unified handler for offer, answer, candidate, and cleanup operations with persistent storage

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Generate simplified signaling key for KV storage
function getSignalingKey(type, peerId) {
  console.log(`🔑 Generating key: ${type}_${peerId}`);
  return `${type}_${peerId}`;
}

// Helper function to create consistent error responses
function createErrorResponse(message, status = 400, details = null) {
  const response = { error: message };
  if (details) response.details = details;
  return new Response(JSON.stringify(response), {
    status,
    headers: corsHeaders
  });
}

// Helper function to create success responses
function createSuccessResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

export async function onRequest(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    console.log(`🚀 SIGNALING REQUEST: ${method} ${url.pathname}${url.search}`);
    console.log(`📅 Timestamp: ${new Date().toISOString()}`);

    // Handle CORS preflight requests
    if (method === 'OPTIONS') {
      console.log('✅ CORS preflight request handled');
      return new Response(null, {
        status: 200,
        headers: corsHeaders
      });
    }

    // Check if KV storage is available
    if (!env.SIGNALING_KV) {
      console.error('❌ KV storage not configured - env.SIGNALING_KV is undefined');
      return createErrorResponse('KV storage not configured', 500);
    }

    console.log('✅ KV storage is available, processing request...');

    if (method === 'POST') {
      console.log('📤 Processing POST request');
      return await handlePostRequest(request, env);
    } else if (method === 'GET') {
      console.log('📥 Processing GET request');
      return await handleGetRequest(request, env);
    } else {
      console.log(`❌ Unsupported method: ${method}`);
      return createErrorResponse('Method not allowed', 405, {
        method,
        allowed: ['GET', 'POST', 'OPTIONS']
      });
    }
  } catch (error) {
    console.error('💥 SIGNALING FUNCTION ERROR:', error.message);
    console.error('📊 Full error object:', error);
    console.error('📈 Error stack:', error.stack);
    return createErrorResponse('Internal server error', 500, error.message);
  }
}

// Handle POST requests (store signaling data)
async function handlePostRequest(request, env) {
  let body;
  try {
    body = await request.json();
    console.log('📦 POST body received:', JSON.stringify(body, null, 2));
  } catch (error) {
    console.error('❌ Error parsing JSON:', error.message);
    return createErrorResponse('Invalid JSON in request body', 400);
  }

  const { type, peerId, data } = body;

  // Validate required fields
  if (!type) {
    console.log('❌ Missing required field: type');
    return createErrorResponse('Missing required field: type');
  }

  // peerId is required for offer/answer/cleanup, not for encode/decode
  if ((type === 'offer' || type === 'answer' || type === 'cleanup') && !peerId) {
    console.log('❌ Missing required field: peerId');
    return createErrorResponse('Missing required field: peerId');
  }

  console.log(`📤 POST request: type=${type}, peerId=${peerId}`);

  // Route based on type
  switch (type) {
    case 'offer':
      if (!data) {
        console.log('❌ Missing required field: data for type offer');
        return createErrorResponse('Missing required field: data for type offer');
      }
      return await handleStoreOffer(peerId, data, env);
    case 'answer':
      if (!data) {
        console.log('❌ Missing required field: data for type answer');
        return createErrorResponse('Missing required field: data for type answer');
      }
      return await handleStoreAnswer(peerId, data, env);
    case 'cleanup':
      const { cleanupType } = body;
      return await handleCleanup(peerId, env, cleanupType);
    case 'encode':
      return handleEncode(body);
    case 'decode':
      return handleDecode(body);
    default:
      console.log(`❌ Invalid type: ${type}`);
      return createErrorResponse(`Invalid type: ${type}. Valid types are: offer, answer, cleanup, encode, decode`);
  }
}

// Handle GET requests (poll for signaling data)
async function handleGetRequest(request, env) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const peerId = url.searchParams.get('peerId');

    console.log(`📥 GET request params: type=${type}, peerId=${peerId}`);

    // Validate required fields
    if (!type) {
      console.log('❌ Missing type parameter');
      return createErrorResponse('Missing required query parameter: type');
    }
    if (!peerId) {
      console.log('❌ Missing peerId parameter');
      return createErrorResponse('Missing required query parameter: peerId');
    }

    console.log(`🔍 Polling for ${type} with peerId: ${peerId}`);
    return await handlePollSignaling(type, peerId, env);
  } catch (error) {
    console.error('💥 Error in handleGetRequest:', error.message);
    console.error('📊 Full error:', error);
    // Return a safe response instead of 500 error
    return createSuccessResponse({
      found: false,
      message: 'Error occurred while processing request',
      error: error.message,
      timestamp: Date.now()
    });
  }
}

// Store offer in KV
async function handleStoreOffer(peerId, data, env) {
  try {
    const key = getSignalingKey('offer', peerId);
    const offerData = {
      type: 'offer',
      peerId: peerId,
      data: data,
      timestamp: Date.now()
    };

    console.log(`💾 Storing offer with key: ${key}`);
    await env.SIGNALING_KV.put(key, JSON.stringify(offerData), { expirationTtl: 300 });
    console.log(`✅ Offer stored successfully for peerId: ${peerId}`);
    
    return createSuccessResponse({
      success: true,
      message: `Offer stored successfully for peerId: ${peerId}`,
      type: 'offer',
      peerId: peerId,
      timestamp: offerData.timestamp
    });
  } catch (error) {
    console.error(`❌ Error storing offer:`, error.message);
    return createErrorResponse(`Failed to store offer`, 500, error.message);
  }
}

// Store answer in KV
async function handleStoreAnswer(peerId, data, env) {
  try {
    const key = getSignalingKey('answer', peerId);
    const answerData = {
      type: 'answer',
      peerId: peerId,
      data: data,
      timestamp: Date.now()
    };

    console.log(`💾 Storing answer with key: ${key}`);
    await env.SIGNALING_KV.put(key, JSON.stringify(answerData), { expirationTtl: 300 });
    console.log(`✅ Answer stored successfully for peerId: ${peerId}`);
    
    return createSuccessResponse({
      success: true,
      message: `Answer stored successfully for peerId: ${peerId}`,
      type: 'answer',
      peerId: peerId,
      timestamp: answerData.timestamp
    });
  } catch (error) {
    console.error(`❌ Error storing answer:`, error.message);
    return createErrorResponse(`Failed to store answer`, 500, error.message);
  }
}


// Poll for signaling data - Simplified version
async function handlePollSignaling(type, peerId, env) {
  try {
    console.log(`🔍 Polling for ${type} with peerId: ${peerId}`);
    
    // Validate input parameters
    if (!type || !peerId) {
      console.log('❌ Invalid input parameters');
      return createSuccessResponse({
        found: false,
        message: 'Invalid request parameters',
        timestamp: Date.now()
      });
    }

    // Check if KV is available
    if (!env || !env.SIGNALING_KV) {
      console.log('❌ KV storage not available');
      return createSuccessResponse({
        found: false,
        message: `No ${type} found for peerId: ${peerId} (KV storage unavailable)`,
        timestamp: Date.now()
      });
    }

    // Get the key for this type and peerId
    const key = getSignalingKey(type, peerId);
    console.log(`🔑 Looking for key: ${key}`);
    
    let signalingDataStr;
    try {
      signalingDataStr = await env.SIGNALING_KV.get(key);
    } catch (kvError) {
      console.log('❌ KV get error:', kvError.message);
      return createSuccessResponse({
        found: false,
        message: `No ${type} found for peerId: ${peerId} (KV access error)`,
        timestamp: Date.now()
      });
    }
    
    if (!signalingDataStr) {
      console.log(`❌ No ${type} found for peerId: ${peerId}`);
      const response = createSuccessResponse({ 
        found: false,
        message: `No ${type} found for peerId: ${peerId}`,
        timestamp: Date.now()
      });
      console.log(`📤 Backend returning not found response:`, response);
      return response;
    }

    let signalingData;
    try {
      signalingData = JSON.parse(signalingDataStr);
      console.log(`✅ Parsed ${type} data for peerId: ${peerId}`);
    } catch (parseError) {
      console.log(`❌ Error parsing ${type} data for key ${key}:`, parseError.message);
      // Try to delete the corrupted data
      try {
        await env.SIGNALING_KV.delete(key);
        console.log('🗑️ Deleted corrupted data');
      } catch (deleteError) {
        console.log('⚠️ Error deleting corrupted data (non-critical):', deleteError.message);
      }
      return createSuccessResponse({
        found: false,
        message: `No ${type} found for peerId: ${peerId} (data corruption detected and cleaned)`,
        timestamp: Date.now()
      });
    }
    
    // Validate required fields
    if (!signalingData || typeof signalingData !== 'object' || 
        !signalingData.type || !signalingData.peerId || !signalingData.data) {
      console.log(`❌ Invalid ${type} data structure for key ${key}`);
      // Try to delete the invalid data
      try {
        await env.SIGNALING_KV.delete(key);
        console.log('🗑️ Deleted invalid data');
      } catch (deleteError) {
        console.log('⚠️ Error deleting invalid data (non-critical):', deleteError.message);
      }
      return createSuccessResponse({
        found: false,
        message: `No ${type} found for peerId: ${peerId} (invalid data detected and cleaned)`,
        timestamp: Date.now()
      });
    }
    
    // For offers and answers, don't delete immediately - let the frontend handle cleanup
    // Only delete candidates immediately as they are consumed
    if (type === 'candidate') {
      try {
        await env.SIGNALING_KV.delete(key);
        console.log(`🗑️ Deleted consumed ${type} data for peerId: ${peerId}`);
      } catch (deleteError) {
        console.log('⚠️ Error deleting consumed data (non-critical):', deleteError.message);
      }
    } else {
      console.log(`ℹ️ Keeping ${type} data for peerId: ${peerId} - will be cleaned up after connection`);
    }

    console.log(`✅ Successfully retrieved ${type} for peerId: ${peerId}`);
    const response = createSuccessResponse({ 
      found: true,
      type: signalingData.type,
      peerId: signalingData.peerId,
      data: signalingData.data,
      timestamp: signalingData.timestamp || Date.now()
    });
    console.log(`📤 Backend returning response:`, response);
    return response;
  } catch (error) {
    console.log(`💥 Unexpected error polling ${type} - returning safe response:`, error.message);
    return createSuccessResponse({
      found: false,
      message: `No ${type} found for peerId: ${peerId} (unexpected error)`,
      timestamp: Date.now()
    });
  }
}


// Handle cleanup - Simplified version
async function handleCleanup(peerId, env, cleanupType = null) {
  try {
    console.log(`🗑️ Cleaning up signaling data for peerId: ${peerId}${cleanupType ? ` (type: ${cleanupType})` : ''}`);
    let deletedCount = 0;
    
    // If peerId is empty, do global cleanup
    if (!peerId) {
      console.log('🌍 Performing global cleanup of all signaling data');
      
      // Get all keys and delete them
      const listResult = await env.SIGNALING_KV.list();
      for (const keyInfo of listResult.keys) {
        await env.SIGNALING_KV.delete(keyInfo.name);
        deletedCount++;
        console.log(`🗑️ Deleted key: ${keyInfo.name}`);
      }
      
      console.log(`✅ Global cleanup completed: ${deletedCount} entries deleted`);
      return createSuccessResponse({
        success: true,
        message: `Cleaned up ${deletedCount} signaling entries globally`,
        type: 'cleanup',
        peerId: null,
        deletedCount,
        timestamp: Date.now()
      });
    }
    
    // Clean up specific peerId
    const types = cleanupType ? [cleanupType] : ['offer', 'answer'];
    
    for (const type of types) {
      const key = getSignalingKey(type, peerId);
      const existing = await env.SIGNALING_KV.get(key);
      if (existing) {
        await env.SIGNALING_KV.delete(key);
        deletedCount++;
        console.log(`🗑️ Deleted ${type} key: ${key}`);
      } else {
        console.log(`ℹ️ No ${type} found for key: ${key}`);
      }
    }
    
    console.log(`✅ Cleanup completed for peerId ${peerId}: ${deletedCount} entries deleted`);
    return createSuccessResponse({
      success: true,
      message: `Cleaned up ${deletedCount} signaling entries for peerId: ${peerId}`,
      type: 'cleanup',
      peerId: peerId,
      deletedCount,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('❌ Error during cleanup:', error.message);
    return createErrorResponse('Failed to cleanup signaling data', 500, error.message);
  }
}

// Handle encode request
function handleEncode(body) {
  try {
    const { dictionary, shift, message } = body;
    if (!dictionary || !shift || message === undefined) {
      return createErrorResponse('Missing required fields: dictionary, shift, message');
    }
    const encoded = Encode_Text(dictionary, shift, message);
    return createSuccessResponse({ encoded });
  } catch (error) {
    return createErrorResponse('Encode failed', 500, error.message);
  }
}

// Handle decode request
function handleDecode(body) {
  try {
    const { dictionary, shift, message } = body;
    if (!dictionary || !shift || message === undefined) {
      return createErrorResponse('Missing required fields: dictionary, shift, message');
    }
    const decoded = Decode_Text(dictionary, shift, message);
    return createSuccessResponse({ decoded });
  } catch (error) {
    return createErrorResponse('Decode failed', 500, error.message);
  }
}

// ============================================================
// WaveLite Chat — Text Encryption (Encode_Text / Decode_Text)
// ------------------------------------------------------------
// Works for ANY language (English, Hindi, Arabic, CJK, emoji,
// punctuation, etc.) by operating directly on Unicode code
// points. Output is always plain, readable alphanumeric text
// (A-Z, a-z, 0-9), since each input character expands into a
// fixed 4-character base-62 block.
//
// IMPORTANT: The DICTIONARY_ALPHABET and DICTIONARY_OFFSET
// values below must NEVER change once deployed — changing them
// will make it impossible to decode previously sent messages.
// ============================================================

const SURROGATE_START = 0xD800;
const SURROGATE_LEN   = 0x800;
const MAX_CODEPOINT   = 0x10FFFF;
const TOTAL_VALID     = (MAX_CODEPOINT + 1) - SURROGATE_LEN;

const BASE  = 62;
const WIDTH = 4;

const DICTIONARY_ALPHABET = {
  1:  "bKhz1JQHpRe3Gky8mvwxYa4iAND2jscXOdP6VrZtLf9BSCF5qToUEM07nWlguI",
  2:  "S9LWa4GYljwAUC7rZvBozx1nuJpkysmt85cfD3R2EgIPq0XMheiKFOTbQVdN6H",
  3:  "PtIqCFSj1kEuXNsbHOpogD9zMGmfcVWi8BnaLv43dQ2ywArK0hZ6YJTRl7eUx5",
  4:  "lvGrFBnw4EyeUuzHCLNbpZJQYqWdt8m6iDagRKMsS0f5Xhk913AxPOTojc7I2V",
  5:  "Rri3Qa84qlgADMLpho6EFt9kj07b5vXsYSPK2TONeHwxBcIzunZJmWVdUyGf1C",
  6:  "2L7RoI0wQcbhHe6KzpBqFZun5lCPVTm3WsfA4idYvkxGUXgN8JtDySrOMaE1j9",
  7:  "ZPV4uwbqtBkWgeLHoTFIamR6lQYf0EyprdnKUjJ9D38xAiGvs75cShX2CMO1zN",
  8:  "7VGJkhSRbP1vDZ89ndmMAKFpuqyoi0LH3jCBYfXIg54NcewazlrWsU6OQETx2t",
  9:  "qIACnwcuj82QloM0XmLkOVJUzWtBiN1db46aRgy9ZvrsFYKEeHTPGhpSfx5D73",
  10: "svrxIitf6lZQ7REunNP0HoAby429kqCBWLjpY8GhV5FJOKmde3XTgczDSMU1wa",
};

const DICTIONARY_OFFSET = {
  1: 50000, 2: 120000, 3: 210000, 4: 300000, 5: 400000,
  6: 500000, 7: 600000, 8: 700000, 9: 800000, 10: 900000,
};

const REVERSE_LOOKUP = {};
for (const key of Object.keys(DICTIONARY_ALPHABET)) {
  const alphabet = DICTIONARY_ALPHABET[key];
  const map = {};
  for (let i = 0; i < alphabet.length; i++) {
    map[alphabet[i]] = i;
  }
  REVERSE_LOOKUP[key] = map;
}

function toLinear(cp) {
  return cp < SURROGATE_START ? cp : cp - SURROGATE_LEN;
}

function fromLinear(idx) {
  return idx < SURROGATE_START ? idx : idx + SURROGATE_LEN;
}

function toBase62Padded(num, alphabet) {
  const digits = [];
  for (let i = 0; i < WIDTH; i++) {
    digits.unshift(alphabet[num % BASE]);
    num = Math.floor(num / BASE);
  }
  return digits.join('');
}

function fromBase62(str, reverseMap) {
  let num = 0;
  for (const ch of str) {
    num = num * BASE + reverseMap[ch];
  }
  return num;
}

function Encode_Text(dictionary, shift, msg) {
  const alphabet = DICTIONARY_ALPHABET[dictionary];
  const offset = DICTIONARY_OFFSET[dictionary];
  if (!alphabet) throw new Error(`Invalid dictionary: ${dictionary}`);

  let result = '';
  for (const ch of msg) {
    const cp = ch.codePointAt(0);
    const idx = toLinear(cp);
    const combined = (idx + shift + offset) % TOTAL_VALID;
    result += toBase62Padded(combined, alphabet);
  }
  return result;
}

function Decode_Text(dictionary, shift, msg) {
  const reverseMap = REVERSE_LOOKUP[dictionary];
  const offset = DICTIONARY_OFFSET[dictionary];
  if (!reverseMap) throw new Error(`Invalid dictionary: ${dictionary}`);
  if (msg.length % WIDTH !== 0) {
    throw new Error('Encoded message length must be a multiple of 4');
  }

  let result = '';
  for (let i = 0; i < msg.length; i += WIDTH) {
    const chunk = msg.substring(i, i + WIDTH);
    const combined = fromBase62(chunk, reverseMap);
    const raw = combined - shift - offset;
    const idx = ((raw % TOTAL_VALID) + TOTAL_VALID) % TOTAL_VALID;
    const cp = fromLinear(idx);
    result += String.fromCodePoint(cp);
  }
  return result;
}

export { Encode_Text, Decode_Text };

