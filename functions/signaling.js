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
function getSignalingKey(type, targetId, senderId) {
  return `${type}:${targetId}:${senderId}`;
}

// Generate a key for polling/retrieval
function getPollingKey(type, targetId) {
  return `${type}:${targetId}:*`;
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

  // Check if KV storage is available
  if (!env.SIGNALING_KV) {
    return new Response(JSON.stringify({ 
      error: 'KV storage not configured',
      message: 'SIGNALING_KV environment variable is required'
    }), {
      status: 500,
      headers: corsHeaders
    });
  }

  try {
    if (method === 'POST') {
      return handlePostRequest(request, env);
    } else if (method === 'GET') {
      return handleGetRequest(request, env);
    } else {
      return new Response(JSON.stringify({ 
        error: 'Method not allowed',
        message: 'Only GET and POST requests are allowed',
        method: method,
        allowed: ['GET', 'POST', 'OPTIONS']
      }), {
        status: 405,
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

// Handle POST requests (store signaling data)
async function handlePostRequest(request, env) {
  const body = await request.json();
  const { type, senderId, targetId, data } = body;

  console.log(`POST request: type=${type}, senderId=${senderId}, targetId=${targetId}`);

  // Validate required fields
  if (!type || !senderId || !targetId) {
    return new Response(JSON.stringify({ 
      error: 'Missing required fields',
      message: 'Request must include type, senderId, and targetId fields'
    }), {
      status: 400,
      headers: corsHeaders
    });
  }

  // Route based on type
  switch (type) {
    case 'offer':
    case 'answer':
    case 'candidate':
      return handleStoreSignaling(type, senderId, targetId, data, env);
    case 'cleanup':
      return handleCleanup(senderId, targetId, env);
    default:
      return new Response(JSON.stringify({ 
        error: 'Invalid type',
        message: `Unknown type: ${type}. Valid types are: offer, answer, candidate, cleanup`
      }), {
        status: 400,
        headers: corsHeaders
      });
  }
}

// Handle GET requests (poll for signaling data)
async function handleGetRequest(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const targetId = url.searchParams.get('targetId');

  console.log(`GET request: type=${type}, targetId=${targetId}`);

  // Validate required fields
  if (!type || !targetId) {
    return new Response(JSON.stringify({ 
      error: 'Missing required fields',
      message: 'Request must include type and targetId query parameters'
    }), {
      status: 400,
      headers: corsHeaders
    });
  }

  return handlePollSignaling(type, targetId, env);
}

// Store signaling data in KV
async function handleStoreSignaling(type, senderId, targetId, data, env) {
  if (!data) {
    return new Response(JSON.stringify({ 
      error: 'Missing required field',
      message: `data field is required for ${type} type`
    }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const key = getSignalingKey(type, targetId, senderId);
  const signalingData = {
    type,
    senderId,
    targetId,
    data,
    timestamp: Date.now()
  };

  // Store in KV with 5 minute expiration
  await env.SIGNALING_KV.put(key, JSON.stringify(signalingData), { expirationTtl: 300 });

  console.log(`Stored ${type} for targetId: ${targetId} from senderId: ${senderId}`);
  
  return new Response(JSON.stringify({ 
    success: true, 
    message: `${type} stored successfully`,
    type,
    senderId,
    targetId
  }), {
    status: 200,
    headers: corsHeaders
  });
}

// Poll for signaling data
async function handlePollSignaling(type, targetId, env) {
  // List all keys for this target peer
  const listResult = await env.SIGNALING_KV.list({ prefix: `${type}:${targetId}:` });
  
  if (listResult.keys.length === 0) {
    return new Response(JSON.stringify({ 
      found: false,
      message: `No ${type} found for targetId: ${targetId}`
    }), {
      status: 200,
      headers: corsHeaders
    });
  }

  // Get the first available signaling data
  const key = listResult.keys[0].name;
  const signalingDataStr = await env.SIGNALING_KV.get(key);
  
  if (!signalingDataStr) {
    return new Response(JSON.stringify({ 
      found: false,
      message: `No ${type} found for targetId: ${targetId}`
    }), {
      status: 200,
      headers: corsHeaders
    });
  }

  const signalingData = JSON.parse(signalingDataStr);
  
  // Delete the consumed data to prevent re-polling
  await env.SIGNALING_KV.delete(key);

  console.log(`Retrieved ${type} for targetId: ${targetId} from senderId: ${signalingData.senderId}`);
  
  return new Response(JSON.stringify({ 
    found: true,
    type: signalingData.type,
    senderId: signalingData.senderId,
    targetId: signalingData.targetId,
    data: signalingData.data,
    timestamp: signalingData.timestamp
  }), {
    status: 200,
    headers: corsHeaders
  });
}

// Handle cleanup
async function handleCleanup(senderId, targetId, env) {
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
    
    console.log(`Global cleanup: deleted ${deletedCount} signaling entries`);
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: `Global cleanup: deleted ${deletedCount} signaling entries`,
      type: 'cleanup',
      senderId: '',
      targetId: '',
      deletedCount
    }), {
      status: 200,
      headers: corsHeaders
    });
  }
  
  // Clean up all types for this sender-target pair
  const types = ['offer', 'answer', 'candidate'];
  
  for (const type of types) {
    const key = getSignalingKey(type, targetId, senderId);
    const existing = await env.SIGNALING_KV.get(key);
    
    if (existing) {
      await env.SIGNALING_KV.delete(key);
      deletedCount++;
    }
  }

  console.log(`Cleaned up ${deletedCount} signaling entries for senderId: ${senderId}, targetId: ${targetId}`);
  
  return new Response(JSON.stringify({ 
    success: true, 
    message: `Cleaned up ${deletedCount} signaling entries`,
    type: 'cleanup',
    senderId,
    targetId,
    deletedCount
  }), {
    status: 200,
    headers: corsHeaders
  });
}
