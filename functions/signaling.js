// Cloudflare Pages Function for WebRTC signaling
// Handles offer, answer, and candidate exchange for peer-to-peer connections

// In-memory storage for signaling data
// In production, you might want to use KV storage or Durable Objects for persistence
const signalingData = new Map();

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  // Handle CORS preflight requests
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }

  try {
    // Clean up expired data on each request
    cleanupExpiredData();

    // Route based on path
    if (path === '/signaling/offer' && method === 'POST') {
      return handleOffer(request);
    } else if (path === '/signaling/answer' && method === 'POST') {
      return handleAnswer(request);
    } else if (path === '/signaling/candidate' && method === 'POST') {
      return handleCandidate(request);
    } else if (path === '/signaling/offer' && method === 'GET') {
      return handleGetOffer(request);
    } else if (path === '/signaling/answer' && method === 'GET') {
      return handleGetAnswer(request);
    } else if (path === '/signaling/cleanup' && method === 'POST') {
      return handleCleanup(request);
    } else {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
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

// Handle offer submission
async function handleOffer(request) {
  try {
    const body = await request.json();
    const { peerId, sdp } = body;

    if (!peerId || !sdp) {
      return new Response(JSON.stringify({ 
        error: 'Missing required fields: peerId, sdp' 
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
      message: 'Offer stored successfully' 
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Error handling offer:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to process offer',
      message: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Handle answer submission
async function handleAnswer(request) {
  try {
    const body = await request.json();
    const { peerId, sdp } = body;

    if (!peerId || !sdp) {
      return new Response(JSON.stringify({ 
        error: 'Missing required fields: peerId, sdp' 
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
      message: 'Answer stored successfully' 
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Error handling answer:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to process answer',
      message: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Handle ICE candidate submission
async function handleCandidate(request) {
  try {
    const body = await request.json();
    const { peerId, candidate } = body;

    if (!peerId || !candidate) {
      return new Response(JSON.stringify({ 
        error: 'Missing required fields: peerId, candidate' 
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const key = getSignalingKey(peerId, 'candidate');
    const existing = signalingData.get(key);
    
    if (existing) {
      // Append to existing candidates array
      existing.candidates = existing.candidates || [];
      existing.candidates.push(candidate);
    } else {
      // Create new candidate entry
      signalingData.set(key, {
        peerId,
        type: 'candidate',
        candidates: [candidate],
        timestamp: Date.now()
      });
    }

    console.log(`Stored candidate for peerId: ${peerId}`);
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Candidate stored successfully' 
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Error handling candidate:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to process candidate',
      message: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Handle offer retrieval
async function handleGetOffer(request) {
  try {
    const url = new URL(request.url);
    const peerId = url.searchParams.get('peerId');

    if (!peerId) {
      return new Response(JSON.stringify({ 
        error: 'Missing peerId parameter' 
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const key = getSignalingKey(peerId, 'offer');
    const offerData = signalingData.get(key);

    if (!offerData) {
      return new Response(JSON.stringify({ 
        found: false,
        message: 'No offer found for this peerId' 
      }), {
        status: 200,
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify({ 
      found: true,
      peerId: offerData.peerId,
      sdp: offerData.sdp,
      timestamp: offerData.timestamp
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Error retrieving offer:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to retrieve offer',
      message: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Handle answer retrieval
async function handleGetAnswer(request) {
  try {
    const url = new URL(request.url);
    const peerId = url.searchParams.get('peerId');

    if (!peerId) {
      return new Response(JSON.stringify({ 
        error: 'Missing peerId parameter' 
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const key = getSignalingKey(peerId, 'answer');
    const answerData = signalingData.get(key);

    if (!answerData) {
      return new Response(JSON.stringify({ 
        found: false,
        message: 'No answer found for this peerId' 
      }), {
        status: 200,
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify({ 
      found: true,
      peerId: answerData.peerId,
      sdp: answerData.sdp,
      timestamp: answerData.timestamp
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Error retrieving answer:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to retrieve answer',
      message: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Handle cleanup of signaling data
async function handleCleanup(request) {
  try {
    const body = await request.json();
    const { peerId } = body;

    if (!peerId) {
      return new Response(JSON.stringify({ 
        error: 'Missing peerId' 
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
      deletedCount
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Error during cleanup:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to cleanup signaling data',
      message: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
