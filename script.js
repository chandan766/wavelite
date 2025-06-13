// --- Config ---
const FORM_URL = "https://docs.google.com/forms/u/0/d/e/1FAIpQLSej8F-WqVXrneoK1caUwagNb8EbcsLG7c2IWbgzlGIxd7xYAQ/formResponse";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1oQ7TEJLutMpXo4gi75jTOmlBGPBHlF3ekE0mtA3nK_M/gviz/tq?tqx=out:json";
const DELETE_URL = "https://script.google.com/macros/s/AKfycbyNUCRo3JKNk_bVq9VcdpbICGuBiTytBGRAjFr7VDrHVvG6TMxaA195sBSSBOeiR1DG/exec";

let localConnection, dataChannel;
let pollingInterval;

$(document).ready(() => {
  $('#peerIdSubmit').click(async function (e) {
    e.preventDefault(); // prevent form default submission

    const username = $('#chat-username').val().trim();
    const peerId = $('#peer-id').val().trim();

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

    if (hasError){
      return;
    }

    // Proceed to connect
    $('#peerIdSubmit').prop('disabled', true).text('Connecting...');
    $('#peerId').val(peerId);
    startConnection(peerId);

    // setTimeout(() => {
    //   $('#peerIdSubmit').prop('disabled', false).text('Connect');
    // }, 30000);
  });

});

async function startConnection(peerId) {
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
  const offer = await localConnection.createOffer();
  await localConnection.setLocalDescription(offer);
  await waitForIceGathering(localConnection);
  await submitSDP(peerId, 'offer', JSON.stringify(localConnection.localDescription));
  console.log("Offer submitted");

  // 🔁 Now start polling for the answer
  pollingInterval = setInterval(async () => {
    const answerEntry = await fetchSDP(peerId, 'answer');
    if (answerEntry) {
      clearInterval(pollingInterval);
      await localConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerEntry.sdp)));
      deletePeerFromSheet(peerId);
      transitionToChat();
    }
  }, 3000); // poll every 3 seconds
}


async function setupAnswerer(offerEntry) {
  const remoteConnection = createPeerConnection();

  remoteConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  await remoteConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerEntry.sdp)));
  const answer = await remoteConnection.createAnswer();
  await remoteConnection.setLocalDescription(answer);

  await waitForIceGathering(remoteConnection);
  await submitSDP(offerEntry.peerId, 'answer', JSON.stringify(remoteConnection.localDescription));
  deletePeerFromSheet(peerId);
  transitionToChat();
}

function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
}

function waitForIceGathering(pc) {
  $('#peerIdSubmit').text('Ice Gathering...');
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
  await fetch(FORM_URL, {
    method: "POST",
    mode: "no-cors",
    body: form
  });
  $('#peerIdSubmit').text('Offer Submitted');
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
        return { peerId: pid, role: r, sdp };
      }
    }
    return null;
  } catch (e) {
    console.error("Failed to fetch from sheet:", e);
    return null;
  }
}

function setupDataChannel() {
  dataChannel.onopen = () => {
    console.log("Data channel opened");
    deletePeerFromSheet(peerId);
    transitionToChat();
  };
  dataChannel.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    displayMessage(msg.name, msg.message, false, 'text', null, msg.messageId, 'delivered');
  };
}

function transitionToChat() {
  $('#login-section').removeClass('d-flex').addClass('d-none');
  $('#chat-section').removeClass('d-none');
  $('#btn-send-text').click(() => {
    const name = $('#chat-username').val() || 'Anonymous';
    const message = $('#chat-message').val();
    const messageId = Date.now().toString();
    if (message && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'text', name, message, messageId }));
      displayMessage(name, message, true, 'text', null, messageId, 'sent');
      $('#chat-message').val('');
    }
  });
}

function displayMessage(name, content, isSelf, type, file, messageId, status) {
  const alignClass = isSelf ? 'self' : 'other';
  const statusIcon = isSelf ? `<span class="status-icon text-muted ms-2"><i class="fas fa-check-double"></i></span>` : '';
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  $('#chat-display').append(`
    <div class="chat-message ${alignClass} px-3">
      <div class="message py-1" style="font-size:12px;font-weight:450;">${content}</div>
      <div class="message-meta d-flex justify-content-end border-top border-secondary mt-2">
        <span class="timestamp text-end" style="font-size:10px;">${isSelf ?'':`<span class="name" style="font-size:12px;">${name}</span>`} ${timestamp}</span>
        ${statusIcon}
      </div>
    </div>
  `);
  $('#chat-display').scrollTop($('#chat-display')[0].scrollHeight);
}


function deletePeerFromSheet(peerId) {
  fetch(DELETE_URL, {
    method: "POST",
    body: new URLSearchParams({ peerId })
  })
    .then(res => res.text())
    .then(result => console.log("Deleted:", result))
    .catch(err => console.error("Delete error:", err));
}