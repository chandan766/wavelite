// Cloudflare Pages Function for WebRTC signaling
// Unified handler for offer, answer, candidate, and cleanup operations with persistent storage

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Generate a unique key for signaling data in KV storage
function getSignalingKey(type, targetId, senderId, candidateIndex = null, sessionId = null) {
  const baseKey = `${type}:${targetId}:${senderId}`;
  
  if (sessionId) {
    // Include session ID for offer/answer to prevent overwrites
    if (type === 'candidate' && candidateIndex !== null) {
      return `${baseKey}:${sessionId}:${candidateIndex}`;
    }
    return `${baseKey}:${sessionId}`;
  }
  
  // Legacy format for backward compatibility
  if (type === 'candidate' && candidateIndex !== null) {
    return `${baseKey}:${candidateIndex}`;
  }
  return baseKey;
}

// Generate a key for polling/retrieval
function getPollingKey(type, targetId) {
  return `${type}:${targetId}:`;
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

    // Enhanced logging for debugging
    if (method !== 'OPTIONS') {
      console.log(`Signaling: ${method} ${url.pathname}${url.search}`);
    }

    // Handle CORS preflight requests
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: corsHeaders
      });
    }

    // Check if KV storage is available
    if (!env.SIGNALING_KV) {
      console.error('KV storage not configured - env.SIGNALING_KV is undefined');
      return createErrorResponse('KV storage not configured', 500);
    }

    console.log('KV storage is available, processing request...');

    if (method === 'POST') {
      console.log('Handling POST request...');
      return await handlePostRequest(request, env);
    } else if (method === 'GET') {
      console.log('Handling GET request...');
      return await handleGetRequest(request, env);
    } else {
      console.log(`Unsupported method: ${method}`);
      return createErrorResponse('Method not allowed', 405, {
        method,
        allowed: ['GET', 'POST', 'OPTIONS']
      });
    }
  } catch (error) {
    console.error('Signaling function error:', error.message);
    console.error('Full error object:', error);
    console.error('Error stack:', error.stack);
    return createErrorResponse('Internal server error', 500, error.message);
  }
}

// Handle POST requests (store signaling data)
async function handlePostRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return createErrorResponse('Invalid JSON in request body', 400);
  }

  const { type, senderId, targetId, data, sessionId } = body;

  // Validate required fields
  if (!type) {
    return createErrorResponse('Missing required field: type');
  }
  if (!senderId) {
    return createErrorResponse('Missing required field: senderId');
  }
  if (!targetId) {
    return createErrorResponse('Missing required field: targetId');
  }

  // Route based on type
  switch (type) {
    case 'offer':
    case 'answer':
      if (!data) {
        return createErrorResponse(`Missing required field: data for type ${type}`);
      }
      return await handleStoreSignaling(type, senderId, targetId, data, sessionId, env);
    case 'candidate':
      if (!data) {
        return createErrorResponse('Missing required field: data for type candidate');
      }
      return await handleStoreCandidate(senderId, targetId, data, sessionId, env);
    case 'cleanup':
      return await handleCleanup(senderId, targetId, sessionId, env);
    default:
      return createErrorResponse(`Invalid type: ${type}. Valid types are: offer, answer, candidate, cleanup`);
  }
}

// Handle GET requests (poll for signaling data)
async function handleGetRequest(request, env) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const targetId = url.searchParams.get('targetId');
    const senderId = url.searchParams.get('senderId'); // Optional
    const sessionId = url.searchParams.get('sessionId'); // Optional

    console.log(`GET request params: type=${type}, targetId=${targetId}, senderId=${senderId || 'none'}, sessionId=${sessionId || 'none'}`);

    // Validate required fields
    if (!type) {
      console.log('Missing type parameter');
      return createErrorResponse('Missing required query parameter: type');
    }
    if (!targetId) {
      console.log('Missing targetId parameter');
      return createErrorResponse('Missing required query parameter: targetId');
    }

    console.log('Calling handlePollSignaling...');
    return await handlePollSignaling(type, targetId, senderId, sessionId, env);
  } catch (error) {
    console.error('Error in handleGetRequest:', error.message);
    console.error('Full error:', error);
    return createErrorResponse('Error handling GET request', 500, error.message);
  }
}

// Store signaling data in KV (for offer/answer)
async function handleStoreSignaling(type, senderId, targetId, data, sessionId, env) {
  try {
    const key = getSignalingKey(type, targetId, senderId, null, sessionId);
    const signalingData = {
      type,
      senderId,
      targetId,
      data,
      sessionId: sessionId || null,
      timestamp: Date.now()
    };

    // Store in KV with 5 minute expiration
    await env.SIGNALING_KV.put(key, JSON.stringify(signalingData), { expirationTtl: 300 });

    return createSuccessResponse({ 
      success: true, 
      message: `${type} stored successfully`,
      type,
      senderId,
      targetId,
      sessionId: sessionId || null,
      timestamp: signalingData.timestamp
    });
  } catch (error) {
    console.error(`Error storing ${type}:`, error.message);
    return createErrorResponse(`Failed to store ${type}`, 500, error.message);
  }
}

// Store ICE candidate in KV (supports multiple candidates)
async function handleStoreCandidate(senderId, targetId, data, sessionId, env) {
  try {
    // Get existing candidate count for this sender-target pair
    const prefix = getPollingKey('candidate', targetId) + senderId;
    const listResult = await env.SIGNALING_KV.list({ prefix });
    
    // Use the count as the index for the new candidate
    const candidateIndex = listResult.keys.length;
    const key = getSignalingKey('candidate', targetId, senderId, candidateIndex, sessionId);
    
    const signalingData = {
      type: 'candidate',
      senderId,
      targetId,
      data,
      candidateIndex,
      sessionId: sessionId || null,
      timestamp: Date.now()
    };

    // Store in KV with 5 minute expiration
    await env.SIGNALING_KV.put(key, JSON.stringify(signalingData), { expirationTtl: 300 });

    return createSuccessResponse({ 
      success: true, 
      message: `candidate stored successfully`,
      type: 'candidate',
      senderId,
      targetId,
      candidateIndex,
      sessionId: sessionId || null,
      timestamp: signalingData.timestamp
    });
  } catch (error) {
    console.error('Error storing candidate:', error.message);
    return createErrorResponse('Failed to store candidate', 500, error.message);
  }
}

// Poll for signaling data
async function handlePollSignaling(type, targetId, senderId, sessionId, env) {
  try {
    console.log(`Polling for ${type}, targetId: ${targetId}, senderId: ${senderId || 'any'}, sessionId: ${sessionId || 'none'}`);
    
    let prefix;
    if (senderId) {
      // If senderId is specified, only look for data from that sender
      prefix = `${type}:${targetId}:${senderId}`;
    } else {
      // Otherwise, look for any data for this target
      prefix = `${type}:${targetId}:`;
    }

    console.log(`Using prefix: ${prefix}`);

    // Check if KV is available before using it
    if (!env.SIGNALING_KV) {
      console.error('KV storage not available in handlePollSignaling');
      return createErrorResponse('KV storage not available', 500);
    }

    let listResult;
    try {
      listResult = await env.SIGNALING_KV.list({ prefix });
      console.log(`KV list returned ${listResult.keys.length} keys`);
    } catch (kvError) {
      console.error('KV list error:', kvError.message);
      return createErrorResponse('KV storage error', 500, kvError.message);
    }
    
    if (listResult.keys.length === 0) {
      console.log(`No ${type} found for targetId: ${targetId}`);
      return createSuccessResponse({ 
        found: false,
        message: `No ${type} found for targetId: ${targetId}${senderId ? ` from senderId: ${senderId}` : ''}${sessionId ? ` with sessionId: ${sessionId}` : ''}`,
        timestamp: Date.now()
      });
    }

    // Special handling for candidate type - return all candidates in a single response
    if (type === 'candidate') {
      return await handlePollCandidates(listResult.keys, env);
    }

    // For offer/answer, get the first available signaling data
    const key = listResult.keys[0].name;
    console.log(`Retrieving data for key: ${key}`);
    
    let signalingDataStr;
    try {
      signalingDataStr = await env.SIGNALING_KV.get(key);
    } catch (kvError) {
      console.error('KV get error:', kvError.message);
      return createErrorResponse('KV storage error', 500, kvError.message);
    }
    
    if (!signalingDataStr) {
      console.log(`No data found for key: ${key}`);
      return createSuccessResponse({ 
        found: false,
        message: `No ${type} found for targetId: ${targetId}${senderId ? ` from senderId: ${senderId}` : ''}${sessionId ? ` with sessionId: ${sessionId}` : ''}`,
        timestamp: Date.now()
      });
    }

    let signalingData;
    try {
      signalingData = JSON.parse(signalingDataStr);
      console.log(`Parsed signaling data for ${type}`);
    } catch (parseError) {
      console.error(`Error parsing signaling data for key ${key}:`, parseError.message);
      // Delete the corrupted data
      try {
        await env.SIGNALING_KV.delete(key);
      } catch (deleteError) {
        console.error('Error deleting corrupted data:', deleteError.message);
      }
      return createErrorResponse(`Corrupted data found and removed`, 500, parseError.message);
    }
    
    // Validate required fields
    if (!signalingData.type || !signalingData.senderId || !signalingData.targetId || !signalingData.data) {
      console.error(`Invalid signaling data structure for key ${key}:`, signalingData);
      // Delete the invalid data
      try {
        await env.SIGNALING_KV.delete(key);
      } catch (deleteError) {
        console.error('Error deleting invalid data:', deleteError.message);
      }
      return createErrorResponse(`Invalid data structure found and removed`, 500, 'Missing required fields');
    }
    
    // Delete the consumed data to prevent re-polling
    try {
      await env.SIGNALING_KV.delete(key);
      console.log(`Deleted consumed data for key: ${key}`);
    } catch (deleteError) {
      console.error('Error deleting consumed data:', deleteError.message);
      // Continue anyway, don't fail the request
    }

    console.log(`Successfully retrieved ${type} for targetId: ${targetId}`);
    return createSuccessResponse({ 
      found: true,
      type: signalingData.type,
      senderId: signalingData.senderId,
      targetId: signalingData.targetId,
      data: signalingData.data,
      sessionId: signalingData.sessionId || null,
      timestamp: signalingData.timestamp || Date.now()
    });
  } catch (error) {
    console.error(`Error polling ${type}:`, error.message);
    console.error('Full error:', error);
    return createErrorResponse(`Failed to poll ${type}`, 500, error.message);
  }
}

// Handle polling for multiple candidates
async function handlePollCandidates(keys, env) {
  try {
    const candidates = [];
    const keysToDelete = [];
    let targetId = null;
    let senderId = null;

    // Collect all candidate data
    for (const keyInfo of keys) {
      const signalingDataStr = await env.SIGNALING_KV.get(keyInfo.name);
      
      if (signalingDataStr) {
        let signalingData;
        try {
          signalingData = JSON.parse(signalingDataStr);
        } catch (parseError) {
          console.error(`Error parsing candidate data for key ${keyInfo.name}:`, parseError.message);
          // Delete the corrupted data
          await env.SIGNALING_KV.delete(keyInfo.name);
          continue;
        }
        
        // Validate required fields
        if (!signalingData.type || !signalingData.senderId || !signalingData.targetId || !signalingData.data) {
          console.error(`Invalid candidate data structure for key ${keyInfo.name}:`, signalingData);
          // Delete the invalid data
          await env.SIGNALING_KV.delete(keyInfo.name);
          continue;
        }
        
        // Get targetId and senderId from the first valid data entry
        if (!targetId) {
          targetId = signalingData.targetId;
          senderId = signalingData.senderId;
        }
        
        candidates.push({
          data: signalingData.data,
          candidateIndex: signalingData.candidateIndex || null,
          sessionId: signalingData.sessionId || null,
          timestamp: signalingData.timestamp || Date.now()
        });
        keysToDelete.push(keyInfo.name);
      }
    }

    // Delete all consumed candidate data
    for (const key of keysToDelete) {
      await env.SIGNALING_KV.delete(key);
    }

    if (candidates.length === 0) {
      return createSuccessResponse({ 
        found: false,
        message: 'No candidates found',
        timestamp: Date.now()
      });
    }

    // Sort candidates by index for consistent ordering
    candidates.sort((a, b) => (a.candidateIndex || 0) - (b.candidateIndex || 0));

    return createSuccessResponse({ 
      found: true,
      type: 'candidate',
      targetId: targetId,
      senderId: senderId,
      candidates: candidates,
      count: candidates.length,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error polling candidates:', error.message);
    return createErrorResponse('Failed to poll candidates', 500, error.message);
  }
}

// Handle cleanup
async function handleCleanup(senderId, targetId, sessionId, env) {
  try {
    let deletedCount = 0;
    
    // If both senderId and targetId are empty, do global cleanup
    if (!senderId && !targetId) {
      const types = ['offer', 'answer', 'candidate'];
      
      for (const type of types) {
        const listResult = await env.SIGNALING_KV.list({ prefix: `${type}:` });
        
        for (const keyInfo of listResult.keys) {
          await env.SIGNALING_KV.delete(keyInfo.name);
          deletedCount++;
        }
      }
      
      return createSuccessResponse({ 
        success: true, 
        message: `Global cleanup: deleted ${deletedCount} signaling entries`,
        type: 'cleanup',
        senderId: '',
        targetId: '',
        sessionId: '',
        deletedCount,
        timestamp: Date.now()
      });
    }
    
    // Clean up all types for this sender-target pair
    const types = ['offer', 'answer'];
    
    // Clean up offer and answer (single entries)
    for (const type of types) {
      const key = getSignalingKey(type, targetId, senderId, null, sessionId);
      const existing = await env.SIGNALING_KV.get(key);
      
      if (existing) {
        await env.SIGNALING_KV.delete(key);
        deletedCount++;
      }
    }
    
    // Clean up all candidates for this sender-target pair (multiple entries)
    const candidatePrefix = getPollingKey('candidate', targetId) + senderId;
    const candidateListResult = await env.SIGNALING_KV.list({ prefix: candidatePrefix });
    
    for (const keyInfo of candidateListResult.keys) {
      await env.SIGNALING_KV.delete(keyInfo.name);
      deletedCount++;
    }

    return createSuccessResponse({ 
      success: true, 
      message: `Cleaned up ${deletedCount} signaling entries`,
      type: 'cleanup',
      senderId,
      targetId,
      sessionId: sessionId || null,
      deletedCount,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error during cleanup:', error.message);
    return createErrorResponse('Failed to cleanup signaling data', 500, error.message);
  }
}
