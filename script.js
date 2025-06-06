let localConnection, remoteConnection;
let dataChannel, receiveChannel;
let settings = {
  autoCopySdp: true,
  clearAfterSubmit: false,
  chatBgColor: '#e5ddd5'
};

$(document).ready(function () {
  // Load settings from localStorage if available
  if (localStorage.getItem('waveliteSettings')) {
    settings = JSON.parse(localStorage.getItem('waveliteSettings'));
    applySettings();
  }

  // === Clipboard Buttons ===
  $('#btn-copy-offer').click(() => copyToClipboard('#offer-sdp'));
  $('#btn-copy-answer').click(() => copyToClipboard('#answer-sdp'));

  $('#btn-paste-offer').click(async () => pasteFromClipboard('#p p'));
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
    localConnection = new RTCPeerConnection();
    dataChannel = localConnection.createDataChannel("chat");
    setupDataChannel();

    localConnection.onicecandidate = (e) => {
      if (e.candidate === null) {
        const sdp = JSON.stringify(localConnection.localDescription);
        $('#offer-sdp').val(sdp);
        if (settings.autoCopySdp) {
          navigator.clipboard.writeText(sdp);
        }
      }
    };

    const offer = await localConnection.createOffer();
    await localConnection.setLocalDescription(offer);
  });

  // === Generate Answer ===
  $('#btn-generate-answer').click(async () => {
    const offer = JSON.parse($('#pasted-offer').val());

    remoteConnection = new RTCPeerConnection();
    remoteConnection.ondatachannel = (event) => {
      receiveChannel = event.channel;
      setupReceiveChannel();
    };

    remoteConnection.onicecandidate = (e) => {
      if (e.candidate === null) {
        const sdp = JSON.stringify(remoteConnection.localDescription);
        $('#answer-sdp').val(sdp);
        if (settings.autoCopySdp) {
          navigator.clipboard.writeText(sdp);
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

  // === Send Chat Message ===
  $('#btn-send').click(() => {
    const msg = $('#chat-message').val();
    const name = $('#chat-username').val() || 'Anonymous';

    if (msg.trim()) {
      const payload = JSON.stringify({ name, message: msg });

      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(payload);
      } else if (receiveChannel && receiveChannel.readyState === 'open') {
        receiveChannel.send(payload);
      } else {
        alert('Connection not ready. Please wait for the connection to establish.');
        return;
      }

      displayMessage(name, msg, true);
      $('#chat-message').val('');
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
  dataChannel.onopen = () => console.log('Data channel open');
  dataChannel.onmessage = (e) => {
    const { name, message } = JSON.parse(e.data);
    displayMessage(name, message, false);
  };
}

function setupReceiveChannel() {
  receiveChannel.onmessage = (e) => {
    const { name, message } = JSON.parse(e.data);
    displayMessage(name, message, false);
  };
  receiveChannel.onopen = () => transitionToChat();
}

function displayMessage(name, message, isSelf) {
  const container = $('#chat-display');
  const alignClass = isSelf ? 'self ms-auto' : 'other me-auto';
  container.append(`
    <div class="chat-message ${alignClass}">
      <div class="name">${name}</div>
      <div class="message">${message}</div>
    </div>
  `);
  container.scrollTop(container[0].scrollHeight);
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