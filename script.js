// --- Config ---
const FORM_URL = "https://docs.google.com/forms/u/0/d/e/1FAIpQLSej8F-WqVXrneoK1caUwagNb8EbcsLG7c2IWbgzlGIxd7xYAQ/formResponse";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1oQ7TEJLutMpXo4gi75jTOmlBGPBHlF3ekE0mtA3nK_M/gviz/tq?tqx=out:json";
const DELETE_URL = "https://script.google.com/macros/s/AKfycbyNUCRo3JKNk_bVq9VcdpbICGuBiTytBGRAjFr7VDrHVvG6TMxaA195sBSSBOeiR1DG/exec";

let localConnection, dataChannel;
let pollingInterval;
let isManuallyConnecting = false;
let peerId = null; // Global peerId variable
const CONNECTION_TIMEOUT = 40000; // 30 seconds timeout for connection
const CHUNK_TIMEOUT = 15000; // 15 seconds for chunk timeout
const MAX_RETRIES = 3; // Maximum retries for missing chunks

// File sending configuration
// const CHUNK_SIZE = 16384; // 16KB chunks for WebRTC data channel
const CHUNK_SIZE = 65536; // 16KB chunks for WebRTC data channel
const BUFFER_THRESHOLD = 262144; // 256KB buffer threshold to prevent overflow
let fileReader = new FileReader();
let currentFile = null;
let currentChunk = 0;
let totalChunks = 0;
let retryCounts = new Map(); // Track retries per messageId
let activeTransfers = new Map(); // Store file references for resending
let receivedFileInfo = null; // Global to store received file metadata

$(document).ready(() => {
  $('#peerIdSubmit').click(async function (e) {
    e.preventDefault(); // prevent form default submission
    isManuallyConnecting = true;
    var username = $('#chat-username').val().trim();
    peerId = $('#peer-id').val().trim(); // Set global peerId

    // Clear previous error messages
    $('#name-error').text('');
    $('#peer-error').text('');

    let hasError = false;

    if (!username) {
      // $('#name-error').text('Name is required');
      // hasError = true;
      username = "Anonymous";
    }

    if (!peerId) {
      // $('#peer-error').text('Peer ID is required');
      // hasError = true;
      peerId = "peer123"
    }

    if (hasError) {
      return;
    }

    // Proceed to connect
    $('#peerIdSubmit').prop('disabled', true).text('Connecting...');
    $('#joinPeer').prop('disabled', true).text('Join');
    $('#peerId').val(peerId);
    startConnection(peerId);
  });

  // Handle file selection
  $('#media-input').change((event) => {
    const file = event.target.files[0];
    if (file) {
      currentFile = file; // Store the selected file
    } else {
      currentFile = null; // Clear if no file is selected
    }
  });

  // Handle file sending on button click
  $('#btn-send-media').click(() => {
    if (!currentFile) {
      $('#media-input').click(); // Trigger file input if no file is selected
    } else if (dataChannel && dataChannel.readyState === 'open') {
      console.log('Sending file, dataChannel state:', dataChannel.readyState);
      const name = $('#chat-username').val() || 'Anonymous';
      const messageId = Date.now().toString();
      currentChunk = 0;
      totalChunks = Math.ceil(currentFile.size / CHUNK_SIZE);

      // Store file reference for potential resending
      activeTransfers.set(messageId, {
        file: currentFile,
        fileName: currentFile.name,
        fileSize: currentFile.size,
        fileType: currentFile.type || 'application/octet-stream',
        totalChunks
      });

      // Send file metadata
      const metadata = {
        type: 'file',
        name,
        messageId,
        fileName: currentFile.name,
        fileSize: currentFile.size,
        fileType: currentFile.type || 'application/octet-stream'
      };
      try {
        dataChannel.send(JSON.stringify(metadata));
        // Create URL for the sent file
        const fileUrl = URL.createObjectURL(currentFile);
        displayMessage(name, currentFile.name, true, 'file', fileUrl, messageId, 'sent', metadata.fileType);

        // Show progress bar
        showProgressBar(messageId, true);
        // Start sending file chunks
        sendFileChunks(messageId);
      } catch (error) {
        console.error('Error sending file:', error);
        hideProgressBar(messageId);
        activeTransfers.delete(messageId);
        alert('Failed to send file. Please try again.');
      }
    } else {
      console.warn('Cannot send file, dataChannel state:', dataChannel ? dataChannel.readyState : 'undefined');
      alert('Please wait until the connection is established before sending a file.');
    }
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
        $('#chat-message').val('');
      } catch (error) {
        console.error('Error sending text message:', error);
        alert('Failed to send message. Please try again.');
      }
    } else {
      console.warn('Cannot send text, dataChannel state:', dataChannel ? dataChannel.readyState : 'undefined');
      alert('Please wait until the connection is established before sending a message.');
    }
  });

    // Handle delete all button click
  $('#delete-all-btn').click(() => {
      fetch(DELETE_URL, {
      method: "POST",
      body: new URLSearchParams({ peerId: '' }) // Empty peerId to delete all entries
    })
      .then(res => res.text())
      .then(result => alert("Deleted all SDP entries:", result))
      .catch(err => alert("Error deleting SDP entries:", err));
    });

    // Handle Join button click
  $('#joinPeer').click(async function (e) {
    e.preventDefault();
    isManuallyConnecting = true;
    const username = $('#chat-username').val().trim();
    peerId = $('#peer-id').val().trim(); // Set global peerId

    // Clear previous error messages
    $('#name-error').text('');
    $('#peer-error').text('');

    let hasError = false;

    if (!username) {
      $('#name-error').text('Name is required');
      hasError = true;
    }

    if (!peerId) {
      $('#peer-error').text('Peer ID is required');
      hasError = true;
    }

    if (hasError) {
      return;
    }

    // Proceed to join
    $('#joinPeer').prop('disabled', true).text('Joining...');
    $('#peerIdSubmit').prop('disabled', true).text('Connect');
    $('#peerId').val(peerId);
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

    // Ask for notification permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      alertBox.text("Notification permission denied. Cannot save Peer ID.")
              .removeClass('d-none');
      return;
    }

    // Save to localStorage
    localStorage.setItem("peerIds", peerIdInput);
    localStorage.setItem("peerName", peerNameInput);
    alert(`Peer ID "${peerIdInput}" saved for notifications.`);

    $('#savePeerModal').modal('hide');
  });

  $('#settingBtn').click(function(){
      const savedPeers = localStorage.getItem("peerIds") || "";
      const savedPeersName = localStorage.getItem("peerName") || "";
      if(savedPeers){
        $('#peerIdToSave').val(savedPeers);
        $('#peerNameToSave').val(savedPeersName);
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
  setupDataChannel();
  $('#peerIdSubmit').text('Offer Creating...');
  try {
    const offer = await localConnection.createOffer();
    await localConnection.setLocalDescription(offer);
    await waitForIceGathering(localConnection);
    console.log(`Submitting offer SDP for peerId: ${peerId}`);
    await submitSDP(peerId, 'offer', JSON.stringify(localConnection.localDescription));
    $('#peerIdSubmit').text("Waiting for peer...");

    // Start polling for the answer with timeout
    let startTime = Date.now();
    pollingInterval = setInterval(async () => {
      if (Date.now() - startTime > CONNECTION_TIMEOUT) {
        clearInterval(pollingInterval);
        $('#peerIdSubmit').prop('disabled', false).text('Connect');
        $('#joinPeer').prop('disabled', false).text('Join');
        alert('Connection timed out. Please try again or check peer ID.');
        return;
      }
      const answerEntry = await fetchSDP(peerId, 'answer');
      if (answerEntry) {
        console.log(`Answer SDP found for peerId: ${peerId}`);
        clearInterval(pollingInterval);
        await localConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerEntry.sdp)));
      }
    }, 5000); // Polling interval 5 seconds
  } catch (error) {
    console.error('Error setting up offerer:', error);
    $('#peerIdSubmit').prop('disabled', false).text('Connect');
    $('#joinPeer').prop('disabled', false).text('Join');
    alert('Failed to establish connection. Please try again.');
  }
}

async function setupAnswerer(offerEntry) {
  localConnection = createPeerConnection();

  localConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  try {
    await localConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerEntry.sdp)));
    const answer = await localConnection.createAnswer();
    await localConnection.setLocalDescription(answer);
    await waitForIceGathering(localConnection);
    console.log(`Submitting answer SDP for peerId: ${offerEntry.peerId}`);
    await submitSDP(offerEntry.peerId, 'answer', JSON.stringify(localConnection.localDescription));
  } catch (error) {
    console.error('Error setting up answerer:', error);
    $('#peerIdSubmit').prop('disabled', false).text('Connect');
    $('#joinPeer').prop('disabled', false).text('Join');
    alert('Failed to establish connection. Please try again.');
  }
}

function createPeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
     // { urls: 'stun:stun2.l.google.com:19302' },
      //{ urls: 'stun:stun3.l.google.com:19302' },
      //{ urls: 'stun:stun4.l.google.com:19302' },
    ], 
    iceCandidatePoolSize: 0 
  });
  pc.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', pc.iceConnectionState);
  };
  return pc;
}

function waitForIceGathering(pc) {
  $('#peerIdSubmit').text('ICE Gathering...');
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
  $('#peerIdSubmit').text('Submitting Offer...');
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
    $('#peerIdSubmit').text('Offer Submitted');
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
  let expectedChunk = 0; // Track expected chunk index

  if (!peerId) {
    console.error("peerId is undefined in setupDataChannel");
    return;
  }

  dataChannel.onopen = () => {
    console.log("Data channel opened for peerId:", peerId);
    deletePeerFromSheet(peerId);
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
            displayMessage(receivedFileInfo.name, receivedFileInfo.fileName, false, 'file', url, receivedFileInfo.messageId, 'delivered', receivedFileInfo.fileType);
            hideProgressBar(receivedFileInfo.messageId);
            receivedBuffers = [];
            receivedFileInfo = null;
            expectedChunk = 0;
            retryCounts.delete(receivedFileInfo?.messageId);
          } catch (error) {
            console.error(`Error reconstructing file ${receivedFileInfo.fileName}:`, error);
            hideProgressBar(receivedFileInfo.messageId);
            alert('Failed to reconstruct received file. Please try again.');
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
                alert(`Failed to receive all chunks for ${receivedFileInfo.fileName} after ${MAX_RETRIES} retries. Please try again.`);
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
      }
    }
  };

  dataChannel.onerror = (error) => {
    console.error('Data channel error:', error);
    if (receivedFileInfo) {
      hideProgressBar(receivedFileInfo.messageId);
      alert(`Data channel error during transfer of ${receivedFileInfo.fileName}. Please reconnect and try again.`);
      receivedBuffers = [];
      receivedFileInfo = null;
      expectedChunk = 0;
      clearTimeout(chunkTimeoutId);
      retryCounts.delete(receivedFileInfo.messageId);
    } else {
      alert('Data channel error occurred. Please reconnect and try again.');
    }
  };
}

function sendFileChunks(messageId) {
  const transfer = activeTransfers.get(messageId);
  if (!transfer || currentChunk * CHUNK_SIZE >= transfer.fileSize) {
    console.log('File sending completed for messageId:', messageId);
    $('#media-input').val('');
    document.getElementById('media-input').value = ''; // Clear file input
    currentFile = null;
    currentChunk = 0;
    totalChunks = 0;
    hideProgressBar(messageId);
    activeTransfers.delete(messageId);
    retryCounts.delete(messageId);
    return;
  }

  // Check buffer to prevent overflow
  if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
    console.log(`Buffer full (${dataChannel.bufferedAmount} bytes), waiting for messageId: ${messageId}`);
    setTimeout(() => sendFileChunks(messageId), 200); // Increased delay to 200ms
    return;
  }

  const start = currentChunk * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, transfer.fileSize);
  fileReader.onload = () => {
    try {
      dataChannel.send(fileReader.result);
      console.log(`Sent file chunk ${currentChunk + 1}/${transfer.totalChunks} for messageId: ${messageId}`);
      currentChunk++;
      // Update progress bar
      updateProgressBar(messageId, (currentChunk / transfer.totalChunks) * 100);
      setTimeout(() => sendFileChunks(messageId), 10); // Small delay to prevent stack overflow
    } catch (error) {
      console.error('Error sending file chunk for messageId:', messageId, error);
      hideProgressBar(messageId);
      activeTransfers.delete(messageId);
      alert('Failed to send file chunk. Please try again.');
      retryCounts.delete(messageId);
      throw error;
    }
  };
  fileReader.onerror = () => {
    console.error('FileReader error for messageId:', messageId);
    hideProgressBar(messageId);
    activeTransfers.delete(messageId);
    alert('Failed to read file chunk. Please try again.');
    retryCounts.delete(messageId);
  };
  const slice = transfer.file.slice(start, end);
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
  // const label = isSender ? 'Uploading' : 'Downloading';
  // Get file name from activeTransfers (sender) or receivedFileInfo (receiver)
  const fileName = isSender 
    ? (activeTransfers.get(messageId)?.fileName || 'Unknown File')
    : (receivedFileInfo?.fileName || 'Unknown File');
  $('#chat-display').append(`
    <div class="chat-message ${alignClass} px-3" id="progress-${messageId}">
      <div class="file-name mt-2" style="font-size: 14px; font-weight: 500;">${fileName}</div>
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

function transitionToChat() {
  if ($('#chat-section').hasClass('d-none')) {
    $('#login-section').removeClass('d-flex').addClass('d-none');
    $('#chat-section').removeClass('d-none');
    $('#peerIdSubmit').prop('disabled', false).text('Disconnect');
    console.log('Transitioned to chat UI');
  }
}

function displayMessage(name, content, isSelf, type, file, messageId, status, fileType = null) {
  const alignClass = isSelf ? 'self' : 'other';
  const statusIcon = isSelf ? `<span class="status-icon text-muted ms-2"><i class="fas fa-check-double"></i></span>` : '';
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let messageContent = content;
  if (type === 'file' && file) {
    const isImage = fileType && fileType.startsWith('image/');
    const isAudio = fileType && fileType.startsWith('audio/');
    const isVideo = fileType && fileType.startsWith('video/');
    const downloadButton = `<a href="${file}" download="${content}" class="btn btn-sm btn-secondary ms-1"><i class="fas fa-download"></i></a>`;
    const fileNameDisplay = `<div class="file-name" style="font-size: 13px; font-weight: 500;">${content}</div>`;

    if (isImage) {
      //messageContent = `<img src="${file}" alt="${content}" style="max-width: 300px; max-height: 300px; object-fit: contain;" class="img-fluid rounded mt-2" /><br>${fileNameDisplay} ${downloadButton}`;
      messageContent = `
      <div class="image-wrapper" style="max-width: 100%; overflow: hidden;">
        <img src="${file}" alt="${content}" class="img-fluid rounded mt-2" style="width: 100%; height: auto; object-fit: contain;" />
      </div>
      <br>${fileNameDisplay} ${downloadButton}`;
    } else if (isAudio) {
      messageContent = `<audio controls src="${file}" class="mt-2" style="width: 100%; max-width: 300px;"></audio><br>${fileNameDisplay} ${downloadButton}`;
    } else if (isVideo) {
      messageContent = `<video controls src="${file}" class="mt-2" style="max-width: 300px; max-height: 250px; object-fit: contain;" class="img-fluid rounded"></video><br>${fileNameDisplay} ${downloadButton}`;
    } else {
      messageContent = `${fileNameDisplay}${downloadButton}`;
    }
  }

  try {
    $('#chat-display').append(`
      <div class="chat-message ${alignClass} px-3">
        <div class="message py-1" style="font-size:12px;font-weight:450;">${messageContent}</div>
        <div class="message-meta d-flex justify-content-end border-top border-secondary mt-2">
          <span class="timestamp text-end" style="font-size:10px;">${isSelf ? '' : `<span class="name" style="font-size:12px;">${name}</span>`} ${timestamp} ${statusIcon}</span>
        </div>
      </div>
    `);
    $('#chat-display').scrollTop($('#chat-display')[0].scrollHeight);
    console.log(`Displayed message for ${type}: ${content}, fileType: ${fileType || 'none'}`);
  } catch (error) {
    console.error(`Error displaying message for ${content}:`, error);
    alert('Failed to display message in UI. Please refresh the page.');
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
  $('#joinPeer').text('Waiting for offer...');

  // Start polling for offer with timeout
  let startTime = Date.now();
  pollingInterval = setInterval(async () => {
    if (Date.now() - startTime > CONNECTION_TIMEOUT) {
      clearInterval(pollingInterval);
      $('#joinPeer').prop('disabled', false).text('Join');
      $('#peerIdSubmit').prop('disabled', false).text('Connect');
      alert('No offer found. Please try again or check peer ID.');
      return;
    }
    const offerEntry = await fetchSDP(peerId, 'offer');
    if (offerEntry) {
      console.log(`Offer SDP found for peerId: ${peerId}, proceeding as answerer`);
      clearInterval(pollingInterval);
      try {
        await setupAnswerer(offerEntry);
        $('#joinPeer').text('Connected');
      } catch (error) {
        console.error('Error during join connection:', error);
        $('#joinPeer').prop('disabled', false).text('Join');
        $('#peerIdSubmit').prop('disabled', false).text('Connect');
        alert('Failed to join connection. Please try again.');
      }
    } else {
      console.log(`No offer SDP found yet for peerId: ${peerId}`);
    }
  }, 3000); // Polling interval 3 seconds
}
