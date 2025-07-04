// --- Config ---
const FORM_URL = "https://docs.google.com/forms/u/0/d/e/1FAIpQLSej8F-WqVXrneoK1caUwagNb8EbcsLG7c2IWbgzlGIxd7xYAQ/formResponse";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1oQ7TEJLutMpXo4gi75jTOmlBGPBHlF3ekE0mtA3nK_M/gviz/tq?tqx=out:json";
const DELETE_URL = "https://script.google.com/macros/s/AKfycbyNUCRo3JKNk_bVq9VcdpbICGuBiTytBGRAjFr7VDrHVvG6TMxaA195sBSSBOeiR1DG/exec";

let localConnection, dataChannel;
let pollingInterval;
let isManuallyConnecting = false;
let peerId = null; // Global peerId variable
const CONNECTION_TIMEOUT = 120000; // 120 seconds timeout for connection
const CHUNK_TIMEOUT = 30000; // 30 seconds for chunk timeout
const MAX_RETRIES = 5; // Maximum retries for missing chunks
let mediaSendQueue = [];
let isSendingFile = false;
const NUM_MEDIA_CHANNELS = 3;
let mediaChannels = [];
let currentSendingChannel = 0;
let mediaReceivingChunks = {};

// File sending configuration
// const CHUNK_SIZE = 16384; // 16KB chunks for WebRTC data channel
const CHUNK_SIZE = 65536; // 64KB chunks for WebRTC data channel
const BUFFER_THRESHOLD = 262144; // 256KB buffer threshold to prevent overflow
let fileReader = new FileReader();
let currentFile = null;
let currentChunk = 0;
let totalChunks = 0;
let retryCounts = new Map(); // Track retries per messageId
let activeTransfers = new Map(); // Store file references for resending
let receivedFileInfo = null; // Global to store received file metadata

$(document).ready(() => {
  let savedProfilePeerId = localStorage.getItem("peerIds") || "";
  let savedProfilePeerName = localStorage.getItem("peerName") || "";
  if(savedProfilePeerName){
      $('#chat-username').val(savedProfilePeerName);
      $('#peer-id').val(savedProfilePeerId);
  }
  
  $('#peerIdSubmit').click(async function (e) {
    e.preventDefault(); // prevent form default submission
    isManuallyConnecting = true;
    var username = $('#chat-username').val().trim();
    peerId = $('#peer-id').val().trim(); // Set global peerId
    $('#chat-username').prop('disabled', true);
    $('#peer-id').prop('disabled', true);

    // Clear previous error messages
    $('#name-error').text('');
    $('#peer-error').text('');

    let hasError = false;

    if (!username) {
      username = "Anonymous";
    }

    if (!peerId) {
      peerId = "peer123"
    }

    if (hasError) {
      return;
    }

    // Proceed to connect
    $('#peerIdSubmit').prop('disabled', true).text('Connecting...');
    $('#joinPeer').prop('disabled', true).text('Join');
    $('#peerId').val(peerId);
    $('#peerBtnGroup').removeClass('d-flex').addClass('d-none');
    $('#connectionStatusPanel').removeClass('d-none');
    updateConnectionStatus('Connecting...','5',false);
    startConnection(peerId);
  });

  // Handle file selection
  $('#media-input-group').change((event) => {
    const file = event.target.files[0];
    if (file) {
      currentFile = file; 
    } else {
      currentFile = null; 
    }
  });

  // Handle file sending on button click
  $('#btn-send-media').click(() => {
    if (!currentFile) {
      showAlert("No file is selected!");
      $('#media-input').click(); // Trigger file input if no file is selected
      return;
    }

    // Create a safe unique ID for the queued item
    const queueId = `queue-${Date.now()}`;
    const fileToSend = {
      file: currentFile,
      queueId: queueId
    };

      // Show "Queued..." bar only if something is sending or already queued
    if (isSendingFile || mediaSendQueue.length > 0) {
      showQueuedProgress(queueId, currentFile.name);
    }

    currentFile = null;
    $('#chat-file').val('');
    // Push to queue
    mediaSendQueue.push(fileToSend);
    
    if (!isSendingFile) {
      processNextFileInQueue();
    }
  });


  $('#reloadBtn').click(function() {
      location.reload(); 
  });
  // Bind text send handler once
  $('#btn-send-text').click(() => {
    const name = $('#chat-username').val() || 'Anonymous';
    const message = $('#chat-message').val();
    const messageId = Date.now().toString();
    if (message && dataChannel && dataChannel.readyState === 'open') {
      console.log('Sending text message, dataChannel state:', dataChannel.readyState);
      try {
        dataChannel.send(JSON.stringify({ type: 'text', name, message, messageId }));
        displayMessage(name, message, true, 'text', null, messageId, 'sent');
        $('#chat-message').val('').focus();
      } catch (error) {
        console.error('Error sending text message:', error);
        showAlert('Failed to send message. Please try again.');
      }
    } else {
      console.warn('Cannot send text, dataChannel state:', dataChannel ? dataChannel.readyState : 'undefined');
      showAlert('Please wait until the connection is established before sending a message.');
    }
  });

      // Handle delete all button click
    $('#delete-all-btn').click(() => {
    fetch(DELETE_URL, {
      method: "POST",
      body: new URLSearchParams({ peerId: '' }) 
    })
    .then(res => res.text())
    .then(result => {
      showAlert(`Deleted all SDP entries: ${result}`, false);
      // Wait 3 seconds before reloading
      setTimeout(() => {
        location.reload();
      }, 3000);
    })
    .catch(err => showAlert(`Error deleting SDP entries: ${err}`));
  });


    // Handle Join button click
  $('#joinPeer').click(async function (e) {
    e.preventDefault();
    isManuallyConnecting = true;
    const username = $('#chat-username').val().trim();
    peerId = $('#peer-id').val().trim(); // Set global peerId
    $('#chat-username').prop('disabled', true);
    $('#peer-id').prop('disabled', true);
    // Clear previous error messages
    $('#name-error').text('');
    $('#peer-error').text('');

    let hasError = false;

    if (!username) {
      $('#name-error').text('Name is required');
      $('#chat-username').prop('disabled', false);
      $('#peer-id').prop('disabled', false);
      hasError = true;
    }

    if (!peerId) {
      $('#peer-error').text('Peer ID is required');
      $('#chat-username').prop('disabled', false);
      $('#peer-id').prop('disabled', false);
      hasError = true;
    }

    if (hasError) {
      return;
    }

    // Proceed to join
    $('#joinPeer').prop('disabled', true).text('Joining...');
    $('#peerIdSubmit').prop('disabled', true).text('Connect');
    $('#peerId').val(peerId);
    $('#peerBtnGroup').removeClass('d-flex').addClass('d-none');
    $('#connectionStatusPanel').removeClass('d-none');
    updateConnectionStatus('Joining...','5',false);
    startJoinConnection(peerId);
  });

  $('#confirmSavePeerBtn').click(async () => {
    const peerIdInput = $('#peerIdToSave').val().trim();
    const peerNameInput = $('#peerNameToSave').val().trim();
    const alertBox = $('#save-peer-alert');
    alertBox.addClass('d-none').text('');

    if (!peerIdInput || !peerNameInput) {
      alertBox.text("Peer ID or Name cannot be empty").removeClass('d-none');
      return;
    }

    // Save to localStorage
    localStorage.setItem("peerIds", peerIdInput);
    localStorage.setItem("peerName", peerNameInput);
    showAlert(`Peer ID "${peerIdInput}" saved for notifications.`,false);

    // Ask for notification permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      alertBox.text("Notification permission denied. Cannot able to notify the joining request")
              .removeClass('d-none');
      return;
    }

    $('#savePeerModal').modal('hide');
  });

  $('#settingBtn').click(function(){
      const savedPeers = localStorage.getItem("peerIds") || "";
      const savedPeersName = localStorage.getItem("peerName") || "";
      if(savedPeers){
        $('#peerIdToSave').val(savedPeers);
        $('#peerNameToSave').val(savedPeersName);
      }
      loadStunSettings();
  });

  // Save when any box is clicked (enforce minimum 2)
$(document).on('change', '.stun-option', () => {
  const selected = $('.stun-option:checked').map(function () {
    return this.value;
  }).get();

  if (selected.length < 1) {
    $('#stun-error').removeClass('d-none');
  } else {
    $('#stun-error').addClass('d-none');
    localStorage.setItem("selectedStunServers", JSON.stringify(selected));
    $('#stunSaveStatus').text(' ( Saved Successfully! )');
    setTimeout(() => {
    $('#stunSaveStatus').text('');
    }, 3000);
  }
});

  let hasPrompted = false;
  let autoCheckInterval = setInterval(async () => {
  if (isManuallyConnecting || hasPrompted) return;
  const savedPeers = localStorage.getItem("peerIds") || "peer123";
  const savedPeerName = localStorage.getItem("peerName") || "Anonymous";
  if (!savedPeers) return;
    const offer = await fetchSDP(savedPeers, "offer");
    if (offer) {
      if (Notification.permission === "granted" && document.visibilityState !== "visible") {
        const notification = new Notification("Wavelite", {
          body: `Peer "${savedPeers}" is requesting to connect.`,
          icon: "/logo.png"
        });

        notification.onclick = function (event) {
          event.preventDefault(); // Prevent default behavior like focusing the tab

          // Bring window to front
          window.focus();

          // Trigger your modal
          $('#autoJoinMessage').text(`Peer "${savedPeers}" is requesting to connect. Do you want to join?`);
          const autoJoinModal = new bootstrap.Modal(document.getElementById('autoJoinModal'));
          autoJoinModal.show();

          // Bind Join button logic
          $('#autoJoinConfirmBtn').off('click').on('click', () => {
            autoJoinModal.hide();
            setTimeout(() => {
              isManuallyConnecting = true;
              $('#peer-id').val(savedPeers);
              $('#chat-username').val(savedPeerName);
              $('#joinPeer').click(); // Trigger join
            }, 300);
          });
        };

      }else if (Notification.permission !== "denied") {
        // Ask for permission only if not previously denied
        Notification.requestPermission().then(permission => {
          if (permission === "granted" && document.visibilityState !== "visible") {
            new Notification("Wavelite", {
              body: `Peer "${savedPeers}" is requesting to connect.`,
              icon: "/logo.png"
            });
          }
        });
      }
      // Show custom modal
      hasPrompted = true; 
      if (document.visibilityState === "visible") {
        $('#autoJoinMessage').text(`Peer "${savedPeers}" is requesting to connect. Do you want to join?`);
        const autoJoinModal = new bootstrap.Modal(document.getElementById('autoJoinModal'));
        autoJoinModal.show();

        // Bind handler to Join button only once
        $('#autoJoinConfirmBtn').off('click').on('click', () => {
          autoJoinModal.hide();
          setTimeout(() => {
            isManuallyConnecting = true;
            $('#peer-id').val(savedPeers);
            $('#chat-username').val(savedPeerName);
            $('#joinPeer').click(); // Trigger join
          }, 300);
        });
      }
      return; // Stop checking after first found match
    }
}, 3000); // every 3 seconds


});

async function startConnection(peerId) {
  console.log(`Starting connection for peerId: ${peerId}`);
  const offerEntry = await fetchSDP(peerId, 'offer');
  if (offerEntry) {
    // Act as answerer
    console.log("Offer found, acting as answerer");
    await setupAnswerer(offerEntry);
  } else {
    // Act as offerer
    console.log("No offer found, acting as offerer");
    await setupOfferer(peerId);
  }
}

async function setupOfferer(peerId) {
  localConnection = createPeerConnection();
  dataChannel = localConnection.createDataChannel("chat");
  mediaChannels = []; 
  for (let i = 0; i < NUM_MEDIA_CHANNELS; i++) {
    const channel = localConnection.createDataChannel(`media-${i}`);
    setupMediaDataChannel(channel, i);
    mediaChannels.push(channel);
  }

  setupDataChannel();
  updateConnectionStatus('Offer Creating...','10',false);
  try {
    const offer = await localConnection.createOffer();
    await localConnection.setLocalDescription(offer);
    await waitForIceGathering(localConnection);
    console.log(`Submitting offer SDP for peerId: ${peerId}`);
    await submitSDP(peerId, 'offer', JSON.stringify(localConnection.localDescription));
    updateConnectionStatus("Waiting for peer...",'100',true);

    // Start polling for the answer with timeout
    let startTime = Date.now();
    pollingInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      if (elapsed > CONNECTION_TIMEOUT) {
        clearInterval(pollingInterval);
        $('#peerIdSubmit').prop('disabled', false).text('Connect');
        $('#joinPeer').prop('disabled', false).text('Join');
        showAlert('Connection timed out. Please try again or check peer ID.');
        $('#delete-all-btn').click();
        return;
      }
      const answerEntry = await fetchSDP(peerId, 'answer');
      const percent = Math.min((elapsed / CONNECTION_TIMEOUT) * 100, 99); 
      updateConnectionStatus("Waiting for peer...",percent,true);
      if (answerEntry) {
          console.log(`Answer SDP found for peerId: ${peerId}`);
          clearInterval(pollingInterval);
          try {
            const sdp = JSON.parse(answerEntry.sdp);
            await localConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            updateConnectionStatus("Connected Successfully!",'100',true);
            console.log("✅ Remote description (answer) set successfully");
          } catch (error) {
            console.error("❌ Failed to set remote description (answer):", error);
          }
      }
    }, 4000); // Polling interval 4 seconds
  } catch (error) {
    console.error('Error setting up offerer:', error);
    $('#peerIdSubmit').prop('disabled', false).text('Connect');
    $('#joinPeer').prop('disabled', false).text('Join');
    showAlert('Failed to establish connection. Please try again.');
  }
}

async function setupAnswerer(offerEntry) {
  localConnection = createPeerConnection();
  localConnection.ondatachannel = (event) => {
    const channel = event.channel;
    if (channel.label === "chat") {
      dataChannel = channel;
      setupDataChannel();
    } else if (channel.label.startsWith("media-")) {
      const index = parseInt(channel.label.split("-")[1]);
      if (!isNaN(index)) {
        mediaChannels[index] = channel;
        setupMediaDataChannel(channel, index);
      }
    }
  };

  try {
    // Log and handle setRemoteDescription separately
    console.log("Parsing and setting remote offer...");
    const offerSDP = JSON.parse(offerEntry.sdp);
    await localConnection.setRemoteDescription(new RTCSessionDescription(offerSDP));
    console.log("✅ Remote description (offer) set successfully");

    // Create and set local answer
    console.log("Creating answer...");
    const answer = await localConnection.createAnswer();
    await localConnection.setLocalDescription(answer);
    console.log("✅ Local answer set successfully");

    // Wait for ICE to complete
    await waitForIceGathering(localConnection);

    // Submit SDP
    console.log(`Submitting answer SDP for peerId: ${offerEntry.peerId}`);
    await submitSDP(offerEntry.peerId, 'answer', JSON.stringify(localConnection.localDescription));

  } catch (error) {
    console.error('❌ Error setting up answerer:', error);
    $('#peerIdSubmit').prop('disabled', false).text('Connect');
    $('#joinPeer').prop('disabled', false).text('Join');
    showAlert('Failed to establish connection. Please try again.');
  }
}


function createPeerConnection() {
  const savedStuns = JSON.parse(localStorage.getItem("selectedStunServers") || "[]");
  const stunServers = savedStuns.length >= 1 ? savedStuns : [
    'stun:global.stun.twilio.com:3478'
  ];

  const pc = new RTCPeerConnection({
    iceServers: stunServers.map(url => ({ urls: url })),
    iceCandidatePoolSize: 0
  });

  pc.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', pc.iceConnectionState);
    const $status = $('#status');
      if (['connected', 'completed'].includes(pc.iceConnectionState)) {
        $status.text('Online');
      } else if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
        $status.text('Offline');
      }
  };
  return pc;
}


function waitForIceGathering(pc) {
  updateConnectionStatus('ICE Gathering...','80',false);
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") return resolve();
    const checkState = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", checkState);
  });
}

async function submitSDP(peerId, role, sdp) {
  updateConnectionStatus('Submitting Offer...','90',false);
  const form = new FormData();
  form.append("entry.1244760702", peerId);
  form.append("entry.443244439", role);
  form.append("entry.479288741", sdp);
  try {
    await fetch(FORM_URL, {
      method: "POST",
      mode: "no-cors",
      body: form
    });
    console.log(`Submitted ${role} SDP for peerId: ${peerId}`);
    updateConnectionStatus('Offer Submitted','99',false);
  } catch (error) {
    console.error(`Error submitting ${role} SDP:`, error);
    throw error;
  }
}

async function fetchSDP(peerId, role) {
  try {
    const res = await fetch(SHEET_URL);
    const text = await res.text();
    const json = JSON.parse(text.substring(47).slice(0, -2));
    const rows = json.table.rows;
    for (let row of rows) {
      const pid = row.c[1]?.v;
      const r = row.c[2]?.v;
      const sdp = row.c[3]?.v;
      if (pid == peerId && r == role && sdp) {
        console.log(`Found ${role} SDP for peerId: ${pid}`);
        return { peerId: pid, role: r, sdp };
      }
    }
    console.log(`No ${role} SDP found for peerId: ${peerId}`);
    return null;
  } catch (e) {
    console.error(`Failed to fetch ${role} SDP for peerId: ${peerId}:`, e);
    return null;
  }
}

function setupDataChannel() {
  let receivedBuffers = [];
  let lastChunkTime = null;
  let chunkTimeoutId = null;
  let expectedChunk = 0; 

  if (!peerId) {
    console.error("peerId is undefined in setupDataChannel");
    return;
  }

  dataChannel.onopen = () => {
    console.log("Data channel opened for peerId:", peerId);
    deletePeerFromSheet(peerId);
    dataChannel.send(JSON.stringify({
      type: 'username',
      name: truncateName($('#chat-username').val() || "Anonymous")
    }));
    transitionToChat();
  };

  dataChannel.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      if (receivedFileInfo) {
        receivedBuffers.push(e.data);
        lastChunkTime = Date.now();
        expectedChunk++;
        const totalReceivedBytes = receivedBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
        console.log(`Received file chunk ${receivedBuffers.length}/${Math.ceil(receivedFileInfo.fileSize / CHUNK_SIZE)} for ${receivedFileInfo.fileName}, total bytes: ${totalReceivedBytes}, expected: ${receivedFileInfo.fileSize}`);
        // Update receiver progress bar
        updateProgressBar(receivedFileInfo.messageId, (totalReceivedBytes / receivedFileInfo.fileSize) * 100);
        // Check if all chunks are received
        if (totalReceivedBytes >= receivedFileInfo.fileSize) {
          console.log(`All chunks received for ${receivedFileInfo.fileName}, reconstructing file`);
          clearTimeout(chunkTimeoutId);
          try {
            const received = new Blob(receivedBuffers, { type: receivedFileInfo.fileType || 'application/octet-stream' });
            const url = URL.createObjectURL(received);
            displayMessage(receivedFileInfo.name, receivedFileInfo.fileName, false, 'file', url, receivedFileInfo.messageId, 'delivered', receivedFileInfo.fileType,receivedFileInfo.fileSize);
            hideProgressBar(receivedFileInfo.messageId);
            receivedBuffers = [];
            receivedFileInfo = null;
            expectedChunk = 0;
            retryCounts.delete(receivedFileInfo?.messageId);
          } catch (error) {
            console.error(`Error reconstructing file ${receivedFileInfo.fileName}:`, error);
            hideProgressBar(receivedFileInfo.messageId);
            showAlert('Failed to reconstruct received file. Please try again.');
            receivedBuffers = [];
            receivedFileInfo = null;
            expectedChunk = 0;
            retryCounts.delete(receivedFileInfo?.messageId);
          }
        } else {
          // Set timeout to check for missing chunks
          clearTimeout(chunkTimeoutId);
          chunkTimeoutId = setTimeout(() => {
            if (receivedFileInfo && totalReceivedBytes < receivedFileInfo.fileSize) {
              const retryCount = retryCounts.get(receivedFileInfo.messageId) || 0;
              if (retryCount < MAX_RETRIES) {
                console.log(`Requesting resend for ${receivedFileInfo.fileName}, received: ${totalReceivedBytes}, expected: ${receivedFileInfo.fileSize}, chunk: ${expectedChunk}`);
                retryCounts.set(receivedFileInfo.messageId, retryCount + 1);
                dataChannel.send(JSON.stringify({
                  type: 'resend_request',
                  messageId: receivedFileInfo.messageId,
                  chunkIndex: expectedChunk
                }));
                lastChunkTime = Date.now(); // Reset timeout
              } else {
                console.error(`Max retries reached for ${receivedFileInfo.fileName}, received: ${totalReceivedBytes}, expected: ${receivedFileInfo.fileSize}`);
                hideProgressBar(receivedFileInfo.messageId);
                showAlert(`Failed to receive all chunks for ${receivedFileInfo.fileName} after ${MAX_RETRIES} retries. Please try again.`);
                receivedBuffers = [];
                receivedFileInfo = null;
                expectedChunk = 0;
                retryCounts.delete(receivedFileInfo.messageId);
              }
            }
          }, CHUNK_TIMEOUT);
        }
      }
    } else {
      const msg = JSON.parse(e.data);
      if (msg.type === 'text') {
        displayMessage(msg.name, msg.message, false, 'text', null, msg.messageId, 'delivered');
      } else if (msg.type === 'file') {
        receivedFileInfo = {
          name: msg.name,
          messageId: msg.messageId,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          fileType: msg.fileType
        };
        receivedBuffers = [];
        lastChunkTime = Date.now();
        expectedChunk = 0;
        console.log(`Received file metadata for ${msg.fileName}, size: ${msg.fileSize}, type: ${msg.fileType}`);
        // Show progress bar for receiver
        showProgressBar(msg.messageId, false);
      } else if (msg.type === 'resend_request') {
        console.log(`Received resend request for messageId: ${msg.messageId}, chunk: ${msg.chunkIndex}`);
        resendFileChunk(msg.messageId, msg.chunkIndex);
      }else if (msg.type === 'username') {
        console.log("Received peer username:", msg.name);
        $('#headerBtnName').text(msg.name).addClass('text-capitalize');
      }
    }
  };

  dataChannel.onerror = (error) => {
    console.error('Data channel error:', error);
    if (receivedFileInfo) {
      hideProgressBar(receivedFileInfo.messageId);
      showAlert(`Data channel error during transfer of ${receivedFileInfo.fileName}. Please reconnect and try again.`);
      receivedBuffers = [];
      receivedFileInfo = null;
      expectedChunk = 0;
      clearTimeout(chunkTimeoutId);
      retryCounts.delete(receivedFileInfo.messageId);
    } else {
      showAlert('Data channel error occurred. Please reconnect and try again.');
    }
  };
}

function setupMediaDataChannel(channel, index) {
  channel.onmessage = (e) => {
    if (!receivedFileInfo || !receivedFileInfo.messageId) return;

    const messageId = receivedFileInfo.messageId;

    if (!mediaReceivingChunks[messageId]) {
      mediaReceivingChunks[messageId] = {
        buffers: [],
        bytesReceived: 0,
        timeoutId: null
      };
    }

    const transfer = mediaReceivingChunks[messageId];
    const data = e.data;
    transfer.buffers.push(data);
    transfer.bytesReceived += data.byteLength;

    updateProgressBar(messageId, (transfer.bytesReceived / receivedFileInfo.fileSize) * 100);

    if (transfer.bytesReceived >= receivedFileInfo.fileSize) {
      clearTimeout(transfer.timeoutId);
      try {
        const received = new Blob(transfer.buffers, { type: receivedFileInfo.fileType || 'application/octet-stream' });
        const url = URL.createObjectURL(received);
        displayMessage(receivedFileInfo.name, receivedFileInfo.fileName, false, 'file', url, messageId, 'delivered', receivedFileInfo.fileType, receivedFileInfo.fileSize);
        hideProgressBar(messageId);
        retryCounts.delete(messageId);
        receivedFileInfo = null;
        delete mediaReceivingChunks[messageId];
      } catch (err) {
        console.error("Failed to reconstruct file:", err);
        showAlert('Failed to reconstruct file.');
      }
    } else {
      clearTimeout(transfer.timeoutId);
      transfer.timeoutId = setTimeout(() => {
        if (transfer.bytesReceived < receivedFileInfo.fileSize) {
          showAlert("Transfer incomplete for messageId: " + messageId + " on channel " + index);
        }
      }, CHUNK_TIMEOUT);
    }
  };

  channel.onerror = (err) => {
    console.error("Media channel error (index " + index + "):", err);
    showAlert("Error on media channel " + index);
  };

  channel.onopen = () => {
    console.log("Media data channel " + index + " opened");
  };
}


function sendFileChunks(messageId, onComplete = () => {}) {
  const transfer = activeTransfers.get(messageId);

  if (!transfer || currentChunk * CHUNK_SIZE >= transfer.fileSize) {
    console.log('✅ File sending completed for messageId:', messageId);
    $('#chat-file').val('');
    $('#btn-toggle-back').click();
    currentFile = null;
    currentChunk = 0;
    totalChunks = 0;
    hideProgressBar(messageId);
    activeTransfers.delete(messageId);
    retryCounts.delete(messageId);
    onComplete(); // Notify the queue to process next
    return;
  }

  const selectedChannel = mediaChannels[currentSendingChannel];
  if (!selectedChannel || selectedChannel.bufferedAmount > BUFFER_THRESHOLD) {
    console.log(`Buffer full (${dataChannel.bufferedAmount} bytes), waiting for messageId: ${messageId}`);
    setTimeout(() => sendFileChunks(messageId, onComplete), 200); // Increased delay to 200ms
    return;
  }

  const start = currentChunk * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, transfer.fileSize);
  const slice = transfer.file.slice(start, end);
  fileReader.onload = () => {
    try {
      const selectedChannel = mediaChannels[currentSendingChannel];
      if (selectedChannel && selectedChannel.readyState === "open") {
        selectedChannel.send(fileReader.result);
        console.log(`📤 Sent file chunk ${currentChunk + 1}/${transfer.totalChunks} via channel ${currentSendingChannel} for messageId: ${messageId}`);
        currentSendingChannel = (currentSendingChannel + 1) % NUM_MEDIA_CHANNELS;
      } else {
        console.warn("⚠️ Selected media channel not open. Falling back to default dataChannel.");
        dataChannel.send(fileReader.result);
      }
      currentChunk++;
      updateProgressBar(messageId, (currentChunk / transfer.totalChunks) * 100);
      setTimeout(() => sendFileChunks(messageId, onComplete), 10);
    } catch (error) {
      console.error('Error sending file chunk for messageId:', messageId, error);
      hideProgressBar(messageId);
      activeTransfers.delete(messageId);
      retryCounts.delete(messageId);
      showAlert('Failed to send file chunk. Please try again.');
      onComplete();
    }
  };

  fileReader.onerror = () => {
    console.error('FileReader error for messageId:', messageId);
    hideProgressBar(messageId);
    activeTransfers.delete(messageId);
    retryCounts.delete(messageId);
    showAlert('Failed to read file chunk. Please try again.');
    onComplete();
  };
  if (!selectedChannel) {
    console.warn("No media channel selected. Using default dataChannel.");
  }
  fileReader.readAsArrayBuffer(slice);
}

function resendFileChunk(messageId, chunkIndex) {
  const transfer = activeTransfers.get(messageId);
  if (!transfer || chunkIndex * CHUNK_SIZE >= transfer.fileSize) {
    console.warn(`Cannot resend chunk ${chunkIndex} for messageId ${messageId}: File or chunk out of range`);
    return;
  }

  if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
    console.log(`Buffer full during resend (${dataChannel.bufferedAmount} bytes), retrying for messageId: ${messageId}`);
    setTimeout(() => resendFileChunk(messageId, chunkIndex), 200);
    return;
  }

  const start = chunkIndex * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, transfer.fileSize);
  fileReader.onload = () => {
    try {
      dataChannel.send(fileReader.result);
      console.log(`Resent file chunk ${chunkIndex + 1}/${transfer.totalChunks} for messageId ${messageId}`);
    } catch (error) {
      console.error(`Error resending file chunk ${chunkIndex} for messageId ${messageId}:`, error);
    }
  };
  fileReader.onerror = () => {
    console.error(`FileReader error during resend for messageId: ${messageId}`);
  };
  const slice = transfer.file.slice(start, end);
  fileReader.readAsArrayBuffer(slice);
}

function showProgressBar(messageId, isSender) {
  const alignClass = isSender ? 'self' : 'other';
  // Get file name from activeTransfers (sender) or receivedFileInfo (receiver)
  const fileName = isSender 
    ? (activeTransfers.get(messageId)?.fileName || 'Unknown File')
    : (receivedFileInfo?.fileName || 'Unknown File');
  $('#chat-display').append(`
    <div class="chat-message ${alignClass} px-3" id="progress-${messageId}">
      <div class="file-name mt-2" style="font-size: 14px; font-weight: 500;">${truncateName(fileName,25)}</div>
      <div class="progress mt-2" style="height: 30px;">
        <div class="progress-bar progress-bar-striped progress-bar-animated bg-info" 
             role="progressbar" 
             style="width: 0%; font-size: 16px; line-height: 30px;" 
             aria-valuenow="0" 
             aria-valuemin="0" 
             aria-valuemax="100">
             <span class="progress-percentage">0%</span>
        </div>
      </div>
    </div>
  `);
  $('#chat-display').scrollTop($('#chat-display')[0].scrollHeight);
}

function updateProgressBar(messageId, percentage) {
  const roundedPercentage = Math.min(100, Math.round(percentage));
  $(`#progress-${messageId} .progress-bar`)
    .css('width', `${roundedPercentage}%`)
    .attr('aria-valuenow', roundedPercentage)
    .find('.progress-percentage')
    .text(`${roundedPercentage}%`);
}

function hideProgressBar(messageId) {
  $(`#progress-${messageId}`).remove();
}

function showQueuedProgress(fakeId, fileName) {
  $('#chat-display').append(`
    <div class="chat-message self px-3" id="${fakeId}">
      <div class="file-name mt-2" style="font-size: 14px; font-weight: 500;">${truncateName(fileName, 25)}</div>
      <div class="progress mt-2" style="height: 30px;">
        <div class="progress-bar bg-secondary text-white" 
             style="width: 100%; font-size: 14px; line-height: 30px;">
          Queued...
        </div>
      </div>
    </div>
  `);
  $('#chat-display').scrollTop($('#chat-display')[0].scrollHeight);
}


function transitionToChat() {
  if ($('#chat-section').hasClass('d-none')) {
    $('#login-section').removeClass('d-flex').addClass('d-none');
    $('#chat-section').removeClass('d-none');
    $('#peerIdSubmit').prop('disabled', false).text('Disconnect');
    console.log('Transitioned to chat UI');
  }
}

function displayMessage(name, content, isSelf, type, file, messageId, status, fileType = null,fileSize = null) {
  const alignClass = isSelf ? 'self' : 'other';
  const statusIcon = isSelf ? `<span class="status-icon text-muted ms-2"><i class="fas fa-check-double"></i></span>` : '';
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let messageContent = content;
  if (type === 'file' && file) {
    const isImage = fileType && fileType.startsWith('image/');
    const isAudio = fileType && fileType.startsWith('audio/');
    const isVideo = fileType && fileType.startsWith('video/');
    const downloadButton = `<a href="${file}" download="${content}" class="btn btn-sm btn-secondary w-100 mt-2 d-block"><i class="fas fa-download me-2"></i>Download</a>`;
    const fileNameDisplay = `<div class="file-name" style="font-size: 13px; font-weight: 500;">${truncateName(content,25)}</div>`;
    const fileSizeAndType = `<div class="file-name" style="font-size: 10px;font-weight:500;">${formatBytes(fileSize)} • <span class="text-uppercase">${content.slice(content.lastIndexOf('.') + 1)}</span></div>`
    if (isImage) {
      messageContent = `
      <div class="image-wrapper" style="max-width: 100%; overflow: hidden;">
        <img src="${file}" alt="${content}" class="img-fluid rounded mt-2" style="width: 100%; height: auto; object-fit: contain;" />
      </div>
      <br>${fileNameDisplay} ${fileSizeAndType} ${downloadButton}`;
    } else if (isAudio) {
        const containerId = `waveform-${Date.now()}`;
        messageContent = `
          <div class="card shadow-sm rounded-3 p-3 mb-2" style="background-color: #f8f9fa;">
            <div id="${containerId}" class="waveform rounded mb-3" style="width: 100%; height: 80px;"></div>

            <div class="text-center fw-semibold mb-2" style="word-break: break-word;">
              ${fileNameDisplay}
            </div>

            <div class="d-flex justify-content-center">
              <button id="btn-${containerId}" onclick="togglePlayPause('${containerId}')" class="btn btn-outline-primary btn-sm rounded-pill px-4">
                <i id="icon-${containerId}" class="fas fa-play"></i>
              </button>
            </div>
          </div>

          <div class="text-end mb-3">
            ${fileSizeAndType}
            ${downloadButton}
          </div>
        `;
        setTimeout(() => {
          const wavesurfer = WaveSurfer.create({
            container: `#${containerId}`,
            waveColor: '#ccc',
            progressColor: '#0d6efd',
            height: 80,
            responsive: true,
          });
          wavesurfer.load(file);
          window[`player_${containerId}`] = wavesurfer;
        }, 100);

    }
    else if (isVideo) {
      messageContent = `
      <div class="plyr-wrapper rounded overflow-hidden mt-2" style="max-width: 100%;">
        <video id="player-${Date.now()}" class="plyr w-100" controls playsinline style="object-fit: contain; min-height: 300px;">
          <source src="${file}" type="video/webm" />
        </video>
      </div>
        <br>${fileNameDisplay} ${fileSizeAndType} ${downloadButton}`;
      setTimeout(() => {
        const players = Plyr.setup('video');
      }, 0);

    } else {
      let fileIconClass = 'fa-file text-dark';
      if (fileType === 'application/pdf') {
        fileIconClass = 'fa-file-pdf text-danger';
      } else if (fileType.includes('word')) {
        fileIconClass = 'fa-file-word text-primary';
      } else if (
        fileType === 'application/vnd.ms-excel' ||
        fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ) {
        fileIconClass = 'fa-file-excel text-success';
      } else if (
        fileType === 'application/vnd.ms-powerpoint' ||
        fileType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ) {
        fileIconClass = 'fa-file-powerpoint text-warning';
      } else if (fileType.includes('zip') || fileType.includes('rar')) {
        fileIconClass = 'fa-file-archive text-muted';
      } else if (fileType.includes('text')) {
        fileIconClass = 'fa-file-lines text-secondary';
      }
      messageContent = `<i class="fas ${fileIconClass} me-2 fs-4"></i> ${fileNameDisplay} ${fileSizeAndType} ${downloadButton}`;
    }
  }

  try {
    $('#chat-display').append(`
      <div class="chat-message ${alignClass} px-3">
        <div class="message py-1" style="font-size:12px;font-weight:450;">${messageContent}</div>
        <div class="message-meta d-flex justify-content-end border-top border-secondary mt-2">
          <span class="timestamp text-end" style="font-size:10px;">${isSelf ? '' : `<span class="name" style="font-size:12px;"></span>`} ${timestamp} ${statusIcon}</span>
        </div>
      </div>
    `);
    $('#chat-display').scrollTop($('#chat-display')[0].scrollHeight);
    console.log(`Displayed message for ${type}: ${content}, fileType: ${fileType || 'none'}`);
  } catch (error) {
    console.error(`Error displaying message for ${content}:`, error);
    showAlert('Failed to display message in UI. Please refresh the page.');
  }
}
function deletePeerFromSheet(peerId) {
  if (!peerId) {
    console.error("peerId is undefined in deletePeerFromSheet");
    return;
  }
  fetch(DELETE_URL, {
    method: "POST",
    body: new URLSearchParams({ peerId })
  })
  .then(res => res.text())
  .then(result => console.log("Deleted SDP for peerId:", peerId, result))
  .catch(err => console.error("Delete error for peerId:", peerId, err));
}

async function startJoinConnection(peerId) {
  console.log(`Starting join connection for peerId: ${peerId}`);
  updateConnectionStatus('Waiting for offer...','10',false);
  // Start polling for offer with timeout
  let startTime = Date.now();
  pollingInterval = setInterval(async () => {
    const elapsed = Date.now() - startTime;
    if (elapsed > CONNECTION_TIMEOUT) {
      clearInterval(pollingInterval);
      $('#joinPeer').prop('disabled', false).text('Join');
      $('#peerIdSubmit').prop('disabled', false).text('Connect');
      showAlert('No offer found. Please try again or check peer ID.');
      return;
    }
    const offerEntry = await fetchSDP(peerId, 'offer');
    const percent = Math.min((elapsed / CONNECTION_TIMEOUT) * 100, 99); 
    updateConnectionStatus("Waiting for offer...",percent,true);
    if (offerEntry) {
      console.log(`Offer SDP found for peerId: ${peerId}, proceeding as answerer`);
      clearInterval(pollingInterval);
      try {
        await setupAnswerer(offerEntry);
        updateConnectionStatus('Joined Successfully','100',true);
      } catch (error) {
        console.error('Error during join connection:', error);
        $('#joinPeer').prop('disabled', false).text('Join');
        $('#peerIdSubmit').prop('disabled', false).text('Connect');
        showAlert('Failed to join connection. Please try again.');
      }
    } else {
      console.log(`No offer SDP found yet for peerId: ${peerId}`);
    }
  }, 3000); // Polling interval 3 seconds
}

// Initialize checkboxes from localStorage or default to 2
function loadStunSettings() {
  const defaultStuns = ['stun:global.stun.twilio.com:3478'];
  const savedStuns = JSON.parse(localStorage.getItem("selectedStunServers") || "[]");

  const selected = savedStuns.length >= 1 ? savedStuns : defaultStuns;
  $('.stun-option').each(function () {
    $(this).prop('checked', selected.includes(this.value));
  });
}

function updateConnectionStatus(message, percent, isFinal = false) {
  $('#connectionStatusPanel').removeClass('d-none');
  $('#connectionStatusText').text(message);
  $('#connectionProgressBar').css('width', percent + '%');

  if (isFinal) {
    $('#connectionProgressBar').removeClass('custom-bg').addClass('bg-success');
    $('#spin-border').addClass('text-success');
    
  }
}

  function showAlert(message, isError = true) {
    // Determine the alert type
    const alertType = isError ? 'alert-danger' : 'alert-success';

    // Create the alert element
    const alert = $(`
      <div class="alert custom-alert ${alertType} alert-dismissible fade show fixed-top d-flex align-items-center rounded-pill" role="alert" style="top: 10px; left: 50%; transform: translateX(-50%); z-index: 2000;">
        <span class="${isError?'text-danger':'text-success'}">${message}</span>
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      </div>
    `);

    // Append the alert to the body
    $('body').append(alert);

    // Auto fade out after 4 seconds
    setTimeout(function() {
      alert.fadeOut(1000, function() {
        $(this).remove(); // Remove the alert after fade out
      });
    }, 4000);
  }
function truncateName(name, len = 10) {
  name = name.trim();
  return name.length > len ? name.slice(0, len - 3) + '...' : name;
}

function togglePlayPause(containerId) {
  const player = window[`player_${containerId}`];
  const icon = document.getElementById(`icon-${containerId}`);
  
  if (!player) return;

  player.playPause(); // Toggle player state

  // Update icon
  if (player.isPlaying()) {
    icon.classList.remove('fa-play');
    icon.classList.add('fa-pause');
  } else {
    icon.classList.remove('fa-pause');
    icon.classList.add('fa-play');
  }
}

function processNextFileInQueue() {
  if (mediaSendQueue.length === 0) {
    isSendingFile = false;
    return;
  }

  const queuedItem = mediaSendQueue.shift(); // contains { file, queueId }
  const file = queuedItem.file;
  const queueId = queuedItem.queueId;
  isSendingFile = true;
  if (queueId) {
    $(`#${queueId}`).remove();
  }
  const name = $('#chat-username').val() || 'Anonymous';
  const messageId = Date.now().toString();
  currentChunk = 0;
  totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  activeTransfers.set(messageId, {
    file,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    totalChunks
  });

  const metadata = {
    type: 'file',
    name,
    messageId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream'
  };

  try {
    dataChannel.send(JSON.stringify(metadata));
    const fileUrl = URL.createObjectURL(file);
    displayMessage(name, file.name, true, 'file', fileUrl, messageId, 'sent', metadata.fileType,metadata.fileSize);
    showProgressBar(messageId, true);
    sendFileChunks(messageId, () => {
      isSendingFile = false;
      processNextFileInQueue();
    });
  } catch (error) {
    console.error('Error sending file:', error);
    hideProgressBar(messageId);
    activeTransfers.delete(messageId);
    showAlert('Failed to send file. Please try again.');
    isSendingFile = false;
    processNextFileInQueue();
  }
}

function handleIncomingChunk(arrayBuffer, channelLabel) {
  if (!receivedFileInfo) return;

  const id = receivedFileInfo.messageId;

  if (!mediaReceivingChunks[id]) {
    mediaReceivingChunks[id] = {
      buffers: [],
      receivedBytes: 0,
      fileInfo: receivedFileInfo
    };
  }

  mediaReceivingChunks[id].buffers.push(arrayBuffer);
  mediaReceivingChunks[id].receivedBytes += arrayBuffer.byteLength;

  const receivedSize = mediaReceivingChunks[id].receivedBytes;
  const totalSize = receivedFileInfo.fileSize;

  updateProgressBar(id, (receivedSize / totalSize) * 100);

  if (receivedSize >= totalSize) {
    try {
      const blob = new Blob(mediaReceivingChunks[id].buffers, {
        type: receivedFileInfo.fileType || "application/octet-stream"
      });
      const url = URL.createObjectURL(blob);
      displayMessage(
        receivedFileInfo.name,
        receivedFileInfo.fileName,
        false,
        "file",
        url,
        id,
        "delivered",
        receivedFileInfo.fileType,
        receivedFileInfo.fileSize
      );
    } catch (err) {
      console.error(`Error creating blob from chunks for ${id}:`, err);
      showAlert("Failed to reconstruct received file.");
    }

    hideProgressBar(id);
    delete mediaReceivingChunks[id];
    receivedFileInfo = null;
  }
}

function formatBytes(sizeInBytes) {
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (sizeInBytes === 0) return '0 Bytes';

  const i = Math.floor(Math.log(sizeInBytes) / Math.log(1024));
  const size = sizeInBytes / Math.pow(1024, i);

  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}
