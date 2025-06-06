let localConnection, remoteConnection;
let dataChannel, receiveChannel;
let settings = {
  autoCopySdp: true,
  clearAfterSubmit: false,
  chatBgColor: '#e5ddd5'
};

// File transfer variables
const CHUNK_SIZE = 16384; // 16KB chunks for data channel
let fileReader = new FileReader();
let receivedFileData = {};
let receivedFileBuffer = [];
let messageStatusMap = new Map(); // Tracks message status (pending, sent, delivered)
let isFileInputMode = false; // Tracks toggle state (text or file input)

$(document).ready(function () {
  // Load settings from localStorage if available
  if (localStorage.getItem('waveliteSettings')) {
    settings = JSON.parse(localStorage.getItem('waveliteSettings'));
    applySettings();
  }

  // === Clipboard Buttons ===
  $('#btn-copy-offer').click(() => copyToClipboard('#offer-sdp'));
  $('#btn-copy-answer').click(() => copyToClipboard('#answer-sdp'));

  $('#btn-paste-offer').click(async () => pasteFromClipboard('#pasted-offer'));
  $('#btn-paste-answer').click(async () => {
    await pasteFromClipboard('#pasted-answer');
    $('#btn-submit-answer').removeClass('d-none');
  });

  // === Clear Buttons ===
  $('#btn-clear-offer').click(() => $('#offer-sdp').val(''));
  $('#btn-clear-answer').click(() => $('#answer-sdp').val(''));
  $('#btn-clear-pasted-offer').click(() => $('#pasted-offer').val(''));
  $('#btn-clear-pasted-answer').click(() => $('#pasted-answer').val(''));

  // === Generate Offer ===
  $('#btn-generate-offer').click(async () => {
    console.time('offerGeneration');
    console.log('Starting offer generation...');

    try {
      localConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });
      console.log('RTCPeerConnection created');

      dataChannel = localConnection.createDataChannel("chat");
      setupDataChannel();
      console.log('Data channel created');

      localConnection.onicecandidate = (e) => {
        console.log('ICE candidate event:', e.candidate);
        if (e.candidate === null) {
          console.log('ICE gathering complete');
          const sdp = JSON.stringify(localConnection.localDescription);
          $('#offer-sdp').val(sdp);
          if (settings.autoCopySdp) {
            navigator.clipboard.writeText(sdp).then(() => {
              console.log('SDP copied to clipboard');
            }).catch(err => {
              console.error('Failed to copy SDP:', err);
            });
          }
          console.timeEnd('offerGeneration');
        }
      };

      const offer = await localConnection.createOffer();
      console.log('Offer created:', offer);
      await localConnection.setLocalDescription(offer);
      console.log('Local description set');
    } catch (error) {
      console.error('Error during offer generation:', error);
      alert('Failed to generate offer. Check console for details.');
      console.timeEnd('offerGeneration');
    }
  });

  // === Generate Answer ===
  $('#btn-generate-answer').click(async () => {
    const offer = JSON.parse($('#pasted-offer').val());

    remoteConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    remoteConnection.ondatachannel = (event) => {
      receiveChannel = event.channel;
      setupReceiveChannel();
    };

    remoteConnection.onicecandidate = (e) => {
      console.log('ICE candidate event:', e.candidate);
      if (e.candidate === null) {
        console.log('ICE gathering complete for answer');
        const sdp = JSON.stringify(remoteConnection.localDescription);
        $('#answer-sdp').val(sdp);
        if (settings.autoCopySdp) {
          navigator.clipboard.writeText(sdp).then(() => {
            console.log('SDP copied to clipboard');
          }).catch(err => {
            console.error('Failed to copy SDP:', err);
          });
        }
      }
    };

    await remoteConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await remoteConnection.createAnswer();
    await remoteConnection.setLocalDescription(answer);
  });

  // === Submit Answer ===
  $('#btn-submit-answer').click(async () => {
    const answer = JSON.parse($('#pasted-answer').val());
    await localConnection.setRemoteDescription(new RTCSessionDescription(answer));
    transitionToChat();
    if (settings.clearAfterSubmit) {
      $('#pasted-answer').val('');
      $('#offer-sdp').val('');
      $('#pasted-offer').val('');
      $('#answer-sdp').val('');
    }
  });

  // === Toggle Input Mode ===
  $('#btn-toggle-input').click(() => {
    isFileInputMode = !isFileInputMode;
    if (isFileInputMode) {
      $('#chat-message').addClass('d-none');
      $('#chat-file').removeClass('d-none');
      $('#btn-send').html('<i class="fas fa-file-upload"></i>');
    } else {
      $('#chat-file').addClass('d-none');
      $('#chat-message').removeClass('d-none');
      $('#btn-send').html('<i class="fas fa-paper-plane"></i>');
    }
  });

  // === Send Message or File ===
  $('#btn-send').click(() => {
    const name = $('#chat-username').val() || 'Anonymous';
    const messageId = Date.now().toString();
    const isChannelOpen = (dataChannel && dataChannel.readyState === 'open') ||
                         (receiveChannel && receiveChannel.readyState === 'open');

    if (isFileInputMode) {
      const fileInput = $('#chat-file')[0];
      if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        displayMessage(name, file.name, true, file.type, file, messageId, isChannelOpen ? 'sent' : 'pending');
        if (isChannelOpen) {
          sendFile(file, name, messageId);
          messageStatusMap.set(messageId, 'sent');
        } else {
          messageStatusMap.set(messageId, 'pending');
          alert('Connection not ready. File queued until connection is established.');
        }
        $('#chat-file').val('');
      } else {
        alert('Please select a file to send.');
      }
    } else {
      const msg = $('#chat-message').val();
      if (msg.trim()) {
        const payload = JSON.stringify({ type: 'text', name, message: msg, messageId });
        displayMessage(name, msg, true, 'text', null, messageId, isChannelOpen ? 'sent' : 'pending');
        if (isChannelOpen) {
          messageStatusMap.set(messageId, 'sent');
          if (dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(payload);
          } else if (receiveChannel && receiveChannel.readyState === 'open') {
            receiveChannel.send(payload);
          }
        } else {
          messageStatusMap.set(messageId, 'pending');
          alert('Connection not ready. Message queued until connection is established.');
        }
        $('#chat-message').val('');
      }
    }
  });
  // === Save Settings ===
  $('#save-settings').click(() => {
    settings.autoCopySdp = $('#auto-copy-sdp').is(':checked');
    settings.clearAfterSubmit = $('#clear-after-submit').is(':checked');
    settings.chatBgColor = $('#chat-bg-color').val();
    localStorage.setItem('waveliteSettings', JSON.stringify(settings));
    applySettings();
    $('#settingsModal').modal('hide');
  });
});

function copyToClipboard(selector) {
  const text = $(selector).val();
  navigator.clipboard.writeText(text);
}

async function pasteFromClipboard(selector) {
  const text = await navigator.clipboard.readText();
  $(selector).val(text);
}

function setupDataChannel() {
  dataChannel.onopen = () => {
    console.log('Data channel open');
    // Update pending messages to sent
    messageStatusMap.forEach((status, messageId) => {
      if (status === 'pending') {
        messageStatusMap.set(messageId, 'sent');
        updateMessageStatus(messageId, 'sent');
        // Resend pending messages/files
        const messageElement = $(`#message-${messageId}`);
        const name = messageElement.find('.name').text();
        const content = messageElement.find('.message').text();
        const type = messageElement.data('type');
        if (type === 'text') {
          const payload = JSON.stringify({ type: 'text', name, message: content, messageId });
          dataChannel.send(payload);
        } else {
          const file = messageElement.data('file');
          if (file) {
            sendFile(file, name, messageId);
          }
        }
      }
    });
  };
  dataChannel.onmessage = (e) => handleMessage(e.data);
}

function setupReceiveChannel() {
  receiveChannel.onopen = () => {
    console.log('Receive channel open');
    transitionToChat();
    // Update pending messages to sent
    messageStatusMap.forEach((status, messageId) => {
      if (status === 'pending') {
        messageStatusMap.set(messageId, 'sent');
        updateMessageStatus(messageId, 'sent');
        // Resend pending messages/files
        const messageElement = $(`#message-${messageId}`);
        const name = messageElement.find('.name').text();
        const content = messageElement.find('.message').text();
        const type = messageElement.data('type');
        if (type === 'text') {
          const payload = JSON.stringify({ type: 'text', name, message: content, messageId });
          receiveChannel.send(payload);
        } else {
          const file = messageElement.data('file');
          if (file) {
            sendFile(file, name, messageId);
          }
        }
      }
    });
  };
  receiveChannel.onmessage = (e) => handleMessage(e.data);
}

function sendFile(file, name, messageId) {
  const fileMeta = {
    type: 'file',
    name,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    messageId
  };
  const metaPayload = JSON.stringify(fileMeta);

  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(metaPayload);
  } else if (receiveChannel && receiveChannel.readyState === 'open') {
    receiveChannel.send(metaPayload);
  }

  let offset = 0;
  fileReader.onload = (e) => {
    const chunk = e.target.result;
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(chunk);
    } else if (receiveChannel && receiveChannel.readyState === 'open') {
      receiveChannel.send(chunk);
    }
    offset += chunk.byteLength;
    if (offset < file.size) {
      readSlice(offset, file);
    }
  };
  readSlice(offset, file);
}

function readSlice(offset, file) {
  const slice = file.slice(offset, offset + CHUNK_SIZE);
  fileReader.readAsArrayBuffer(slice);
}

function handleMessage(data) {
  if (typeof data === 'string') {
    const payload = JSON.parse(data);
    if (payload.type === 'text') {
      displayMessage(payload.name, payload.message, false, 'text', null, payload.messageId, 'delivered');
      messageStatusMap.set(payload.messageId, 'delivered');
    } else if (payload.type === 'file') {
      receivedFileData = {
        name: payload.name,
        fileName: payload.fileName,
        fileType: payload.fileType,
        fileSize: payload.fileSize,
        messageId: payload.messageId,
        receivedSize: 0
      };
      receivedFileBuffer = [];
    }
  } else if (data instanceof ArrayBuffer) {
    receivedFileBuffer.push(data);
    receivedFileData.receivedSize += data.byteLength;

    if (receivedFileData.receivedSize >= receivedFileData.fileSize) {
      const blob = new Blob(receivedFileBuffer, { type: receivedFileData.fileType });
      displayMessage(receivedFileData.name, receivedFileData.fileName, false, receivedFileData.fileType, blob, receivedFileData.messageId, 'delivered');
      receivedFileData = {};
      receivedFileBuffer = [];
    }
  }
}

function displayMessage(name, content, isSelf, type, file = null, messageId, status = 'pending') {
  const container = $('#chat-display');
  const alignClass = isSelf ? 'self ms-auto' : 'other me-auto';
  const timestamp = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  let contentHtml = '';
  let statusIcon = '';

  if (status === 'pending') {
    statusIcon = '<i class="fas fa-clock status-icon text-muted"></i>';
  } else if (status === 'sent') {
    statusIcon = '<i class="fas fa-check status-icon text-muted"></i>';
  } else if (status === 'delivered') {
    statusIcon = '<i class="fas fa-check-double status-icon text-info"></i>';
  }

  if (type === 'text') {
    contentHtml = `<div class="message">${content}</div>`;
  } else if (type.startsWith('image/')) {
    const url = file ? URL.createObjectURL(file) : content;
    contentHtml = `
      <div class="message">
        <img src="${url}" class="media-content" alt="Shared image">
        <a href="${url}" download="${content}" class="btn btn-sm btn-outline-secondary mt-2 download-btn">
          <i class="fas fa-download"></i> Download
        </a>
      </div>`;
  } else if (type.startsWith('audio/')) {
    const url = file ? URL.createObjectURL(file) : content;
    contentHtml = `
      <div class="message">
        <audio controls class="media-content"><source src="${url}" type="${type}"></audio>
        <a href="${url}" download="${content}" class="btn btn-sm btn-outline-secondary mt-2 download-btn">
          <i class="fas fa-download"></i> Download
        </a>
      </div>`;
  } else if (type.startsWith('video/')) {
    const url = file ? URL.createObjectURL(file) : content;
    contentHtml = `
      <div class="message">
        <video controls class="media-content"><source src="${url}" type="${type}"></video>
        <a href="${url}" download="${content}" class="btn btn-sm btn-outline-secondary mt-2 download-btn">
          <i class="fas fa-download"></i> Download
        </a>
      </div>`;
  } else {
    const url = file ? URL.createObjectURL(file) : content;
    contentHtml = `
      <div class="message">
        <i class="fas fa-file-alt"></i> ${content}
        <a href="${url}" download="${content}" class="btn btn-sm btn-outline-secondary mt-2 download-btn">
          <i class="fas fa-download"></i> Download
        </a>
      </div>`;
  }

  container.append(`
    <div class="chat-message ${alignClass}" id="message-${messageId}" data-type="${type}" data-file="${file ? 'file' : ''}">
      <div class="name">${name}</div>
      ${contentHtml}
      <div class="message-meta d-flex justify-content-end gap-1">
        <span class="timestamp text-muted">${timestamp}</span>
        ${isSelf ? statusIcon : ''}
      </div>
    </div>
  `);
  container.scrollTop(container[0].scrollHeight);
}

function updateMessageStatus(messageId, status) {
  const messageElement = $(`#message-${messageId} .message-meta`);
  if (messageElement.length) {
    let statusIcon = '';
    if (status === 'pending') {
      statusIcon = '<i class="fas fa-clock status-icon text-muted"></i>';
    } else if (status === 'sent') {
      statusIcon = '<i class="fas fa-check status-icon text-muted"></i>';
    } else if (status === 'delivered') {
      statusIcon = '<i class="fas fa-check-double status-icon text-info"></i>';
    }
    messageElement.find('.status-icon').replaceWith(statusIcon);
  }
}

function transitionToChat() {
  ['#card-generate-offer', '#card-paste-offer', '#card-generate-answer', '#card-paste-answer']
    .forEach(id => $(id).addClass('d-none'));
  $('#card-chat').removeClass('d-none');
}

function applySettings() {
  $('#auto-copy-sdp').prop('checked', settings.autoCopySdp);
  $('#clear-after-submit').prop('checked', settings.clearAfterSubmit);
  $('#chat-bg-color').val(settings.chatBgColor);
  $('#chat-display').css('background-color', settings.chatBgColor);
}