// Cloudflare Pages Function for WebRTC signaling
// Unified handler for offer, answer, and cleanup operations

// In-memory storage for signaling data
// In production, you might want to use KV storage or Durable Objects for persistence
const signalingData = new Map();

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Cleanup function to remove expired signaling data
function cleanupExpiredData() {
  const now = Date.now();
  const EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes
  
  for (const [key, data] of signalingData.entries()) {
    if (now - data.timestamp > EXPIRY_TIME) {
      signalingData.delete(key);
    }
  }
}

// Generate a unique key for signaling data
function getSignalingKey(peerId, type) {
  return `${peerId}-${type}`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  console.log(`Signaling function called: ${method} ${path}`);

  // Handle CORS preflight requests
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }

  // Only allow POST requests
  if (method !== 'POST') {
    return new Response(JSON.stringify({ 
      error: 'Method not allowed',
      message: 'Only POST requests are allowed',
      method: method,
      allowed: ['POST', 'OPTIONS']
    }), {
      status: 405,
      headers: corsHeaders
    });
  }

  try {
    // Clean up expired data on each request
    cleanupExpiredData();

    // Parse the request body
    const body = await request.json();
    const { type, peerId, data } = body;

    console.log(`Signaling request: type=${type}, peerId=${peerId}`);

    // Validate required fields
    if (!type) {
      return new Response(JSON.stringify({ 
        error: 'Missing required field: type',
        message: 'Request must include a type field'
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // Route based on type
    switch (type) {
      case 'offer':
        return handleOffer(peerId, data);
      case 'answer':
        return handleAnswer(peerId, data);
      case 'cleanup':
        return handleCleanup(peerId);
      default:
        return new Response(JSON.stringify({ 
          error: 'Invalid type',
          message: `Unknown type: ${type}. Valid types are: offer, answer, cleanup`
        }), {
          status: 400,
          headers: corsHeaders
        });
    }
  } catch (error) {
    console.error('Signaling function error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      message: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Handle offer storage
function handleOffer(peerId, sdp) {
  if (!peerId || !sdp) {
    return new Response(JSON.stringify({ 
      error: 'Missing required fields',
      message: 'peerId and data (SDP) are required for offer type'
    }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const key = getSignalingKey(peerId, 'offer');
  signalingData.set(key, {
    peerId,
    type: 'offer',
    sdp,
    timestamp: Date.now()
  });

  console.log(`Stored offer for peerId: ${peerId}`);
  
  return new Response(JSON.stringify({ 
    success: true, 
    message: 'Offer stored successfully',
    type: 'offer',
    peerId: peerId
  }), {
    status: 200,
    headers: corsHeaders
  });
}

// Handle answer storage
function handleAnswer(peerId, sdp) {
  if (!peerId || !sdp) {
    return new Response(JSON.stringify({ 
      error: 'Missing required fields',
      message: 'peerId and data (SDP) are required for answer type'
    }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const key = getSignalingKey(peerId, 'answer');
  signalingData.set(key, {
    peerId,
    type: 'answer',
    sdp,
    timestamp: Date.now()
  });

  console.log(`Stored answer for peerId: ${peerId}`);
  
  return new Response(JSON.stringify({ 
    success: true, 
    message: 'Answer stored successfully',
    type: 'answer',
    peerId: peerId
  }), {
    status: 200,
    headers: corsHeaders
  });
}

// Handle cleanup
function handleCleanup(peerId) {
  if (!peerId) {
    return new Response(JSON.stringify({ 
      error: 'Missing required field',
      message: 'peerId is required for cleanup type'
    }), {
      status: 400,
      headers: corsHeaders
    });
  }

  // Remove all signaling data for this peerId
  const offerKey = getSignalingKey(peerId, 'offer');
  const answerKey = getSignalingKey(peerId, 'answer');
  const candidateKey = getSignalingKey(peerId, 'candidate');

  let deletedCount = 0;
  if (signalingData.has(offerKey)) {
    signalingData.delete(offerKey);
    deletedCount++;
  }
  if (signalingData.has(answerKey)) {
    signalingData.delete(answerKey);
    deletedCount++;
  }
  if (signalingData.has(candidateKey)) {
    signalingData.delete(candidateKey);
    deletedCount++;
  }

  console.log(`Cleaned up ${deletedCount} signaling entries for peerId: ${peerId}`);
  
  return new Response(JSON.stringify({ 
    success: true, 
    message: `Cleaned up ${deletedCount} signaling entries`,
    type: 'cleanup',
    peerId: peerId,
    deletedCount: deletedCount
  }), {
    status: 200,
    headers: corsHeaders
  });
}
