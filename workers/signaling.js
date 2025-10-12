// Cloudflare Worker for WebRTC Signaling
// Handles offer, answer, and ICE candidate exchange for WaveLite Chat

// In-memory storage for signaling data
// In production, you might want to use KV storage for persistence
const signalingData = new Map();

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Helper function to create response with CORS headers
function createResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// Helper function to handle CORS preflight requests
function handleCORS(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }
  return null;
}

// Helper function to validate peer ID
function isValidPeerId(peerId) {
  return peerId && typeof peerId === 'string' && peerId.length > 0 && peerId.length <= 100;
}

// Helper function to validate SDP data
function isValidSDP(sdp) {
  return sdp && typeof sdp === 'string' && sdp.length > 0;
}

// Helper function to clean up old entries (older than 5 minutes)
function cleanupOldEntries() {
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  
  for (const [key, entry] of signalingData.entries()) {
    if (entry.timestamp < fiveMinutesAgo) {
      signalingData.delete(key);
    }
  }
}

// Main request handler
export default {
  async fetch(request, env, ctx) {
    try {
      // Handle CORS preflight
      const corsResponse = handleCORS(request);
      if (corsResponse) return corsResponse;

      const url = new URL(request.url);
      const path = url.pathname;

      // Clean up old entries periodically
      cleanupOldEntries();

      // Route requests based on path
      if (path === '/workers/signaling' || path === '/signaling') {
        return await handleSignaling(request);
      } else if (path.startsWith('/workers/signaling/') || path.startsWith('/signaling/')) {
        const action = path.split('/').pop();
        return await handleSignalingAction(request, action);
      } else {
        return createResponse({ error: 'Not found' }, 404);
      }
    } catch (error) {
      console.error('Worker error:', error);
      return createResponse({ error: 'Internal server error' }, 500);
    }
  },
};

// Handle signaling requests
async function handleSignaling(request) {
  if (request.method !== 'POST') {
    return createResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await request.json();
    const { type, peerId, data } = body;

    // Validate input
    if (!type || !peerId || !data) {
      return createResponse({ error: 'Missing required fields: type, peerId, data' }, 400);
    }

    if (!isValidPeerId(peerId)) {
      return createResponse({ error: 'Invalid peer ID' }, 400);
    }

    if (!isValidSDP(data)) {
      return createResponse({ error: 'Invalid SDP data' }, 400);
    }

    // Store signaling data
    const key = `${peerId}_${type}`;
    signalingData.set(key, {
      peerId,
      type,
      data,
      timestamp: Date.now(),
    });

    console.log(`Stored ${type} for peer ${peerId}`);

    return createResponse({ 
      success: true, 
      message: `${type} stored successfully`,
      peerId,
      type 
    });

  } catch (error) {
    console.error('Error handling signaling request:', error);
    return createResponse({ error: 'Invalid JSON or request format' }, 400);
  }
}

// Handle specific signaling actions
async function handleSignalingAction(request, action) {
  if (request.method === 'GET') {
    return await getSignalingData(request, action);
  } else if (request.method === 'POST') {
    return await postSignalingData(request, action);
  } else if (request.method === 'DELETE') {
    return await deleteSignalingData(request, action);
  } else {
    return createResponse({ error: 'Method not allowed' }, 405);
  }
}

// Get signaling data (for polling)
async function getSignalingData(request, action) {
  const url = new URL(request.url);
  const peerId = url.searchParams.get('peerId');
  const type = url.searchParams.get('type');

  if (!peerId || !type) {
    return createResponse({ error: 'Missing peerId or type parameter' }, 400);
  }

  if (!isValidPeerId(peerId)) {
    return createResponse({ error: 'Invalid peer ID' }, 400);
  }

  const key = `${peerId}_${type}`;
  const entry = signalingData.get(key);

  if (!entry) {
    return createResponse({ 
      success: true, 
      found: false,
      message: `No ${type} found for peer ${peerId}` 
    });
  }

  return createResponse({
    success: true,
    found: true,
    peerId: entry.peerId,
    type: entry.type,
    sdp: entry.data,
    timestamp: entry.timestamp
  });
}

// Post signaling data
async function postSignalingData(request, action) {
  try {
    const body = await request.json();
    const { peerId, data } = body;

    if (!peerId || !data) {
      return createResponse({ error: 'Missing peerId or data' }, 400);
    }

    if (!isValidPeerId(peerId)) {
      return createResponse({ error: 'Invalid peer ID' }, 400);
    }

    if (!isValidSDP(data)) {
      return createResponse({ error: 'Invalid SDP data' }, 400);
    }

    const key = `${peerId}_${action}`;
    signalingData.set(key, {
      peerId,
      type: action,
      data,
      timestamp: Date.now(),
    });

    console.log(`Stored ${action} for peer ${peerId}`);

    return createResponse({ 
      success: true, 
      message: `${action} stored successfully`,
      peerId,
      type: action 
    });

  } catch (error) {
    console.error('Error posting signaling data:', error);
    return createResponse({ error: 'Invalid JSON or request format' }, 400);
  }
}

// Delete signaling data
async function deleteSignalingData(request, action) {
  const url = new URL(request.url);
  const peerId = url.searchParams.get('peerId');

  // If peerId is empty or not provided, delete all entries
  if (!peerId || peerId === '') {
    const totalEntries = signalingData.size;
    signalingData.clear();
    console.log(`Deleted all ${totalEntries} signaling entries`);
    return createResponse({ 
      success: true, 
      message: `Deleted all ${totalEntries} signaling entries`,
      deletedCount: totalEntries 
    });
  }

  if (!isValidPeerId(peerId)) {
    return createResponse({ error: 'Invalid peer ID' }, 400);
  }

  // Delete all entries for this peer ID
  let deletedCount = 0;
  for (const [key, entry] of signalingData.entries()) {
    if (entry.peerId === peerId) {
      signalingData.delete(key);
      deletedCount++;
    }
  }

  console.log(`Deleted ${deletedCount} entries for peer ${peerId}`);

  return createResponse({ 
    success: true, 
    message: `Deleted ${deletedCount} entries for peer ${peerId}`,
    deletedCount 
  });
}
