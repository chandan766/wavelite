const SIGNALING_URL = '/signaling';

let localConnection, dataChannel;
let pollingInterval;
let isManuallyConnecting = !1;
let peerId = null;
let mediaSendQueue = [];
let isSendingFile = !1;
let pingIntervalId = null;
let mediaChannels = [];
let mediaReceivingChunks = {};
let lastPingReceivedTime = Date.now();

const CONNECTION_TIMEOUT = 120000;
const CHUNK_TIMEOUT = 5000;
const MAX_RETRIES = 5;
const NUM_MEDIA_CHANNELS = 3;
const PING_INTERVAL = 10000;
const CHUNK_SIZE = 65536;
const BUFFER_THRESHOLD = 262144;
const ACK_TIMEOUT = 20000;

let secureEnabled = !1;
let isUsingRelay = !1;

const ENCODE_DECODE_URL = SIGNALING_URL;

const WL_DEFAULT_BLUE = "#2563EB";
const WL_DEFAULT_CYAN = "#06B6D4";
let wlCustomThemeColor = null;
let wlSecureSyncActive = !1;

let fileReader = new FileReader();
let currentFile = null;
let retryCounts = new Map();
let activeTransfers = new Map();
const receivedTransfers = new Map();
let nextTransferIndex = 1;
const receiverTransferIndexMap = new Map();
let pendingSendBatch = [];
let ackSafetyTimeouts = new Map();
let currentReceivingMessageId = null;

$(document).ready(() => {
  let savedProfilePeerId = localStorage.getItem("peerIds") || "";
  let savedProfilePeerName = localStorage.getItem("peerName") || "";
  if (savedProfilePeerName) {
    $("#chat-username").val(savedProfilePeerName);
    $("#peer-id").val(savedProfilePeerId);
  }

  $("#peerIdSubmit").click(async function (e) {
    e.preventDefault();
    isManuallyConnecting = !0;
    var username = $("#chat-username").val().trim();
    peerId = $("#peer-id").val().trim();
    $("#chat-username").prop("disabled", !0);
    $("#peer-id").prop("disabled", !0);
    $("#name-error").text("");
    $("#peer-error").text("");
    let hasError = !1;

    if (!username) {
      username = "Anonymous";
    }

    if (!peerId) {
      peerId = "peer123";
    }

    if (hasError) {
      return;
    }

    $("#peerIdSubmit").prop("disabled", !0).text("Connecting...");
    $("#joinPeer").prop("disabled", !0).text("Join");
    $("#peerId").val(peerId);
    $("#peerBtnGroup").removeClass("d-flex").addClass("d-none");
    $("#connectionStatusPanel").removeClass("d-none");
    updateConnectionStatus("Connecting...", "5", !1);
    startConnection(peerId, "connect");
  });

  $("#media-input-group").change((event) => {
    const file = event.target.files[0];
    if (file) {
      currentFile = file;
    } else {
      currentFile = null;
    }
  });

  $("#btn-send-media").click(() => {
    if (!currentFile) {
      showAlert("No file is selected!");
      $("#media-input").click();
      return;
    }

    const queueId = `queue-${Date.now()}`;
    const fileToSend = {
      file: currentFile,
      queueId: queueId,
    };

    if (isSendingFile || mediaSendQueue.length > 0) {
      showQueuedProgress(queueId, currentFile.name);
    }

    currentFile = null;
    $("#chat-file").val("");
    mediaSendQueue.push(fileToSend);

    if (!isSendingFile) {
      processNextFileInQueue();
    }
  });

  $("#reloadBtn").click(function () {
    location.reload();
  });

  $("#btn-send-text").click(async () => {
    const name = $("#chat-username").val() || "Anonymous";
    const rawMessage = $("#chat-message").val();
    const messageId = Date.now().toString();

    if (!rawMessage || !dataChannel || dataChannel.readyState !== "open") {
      console.warn("Cannot send text, dataChannel state:", dataChannel ? dataChannel.readyState : "undefined");
      showAlert("Please wait until the connection is established before sending a message.");
      return;
    }

    try {
      let payload;
      if (secureEnabled) {
        const dictionary = Math.floor(Math.random() * 10) + 1;
        const shift = Math.floor(Math.random() * 30) + 1;
        const encoded = await callEncode(dictionary, shift, rawMessage);
        if (!encoded) {
          showAlert("Encryption failed — check console for details. Message not sent.");
          return;
        }
        payload = JSON.stringify({
          type: "text",
          message: encoded,
          encrypted: !0,
          messageId,
          sender: name,
          meta: { dictionary, shift }
        });
      } else {
        payload = JSON.stringify({
          type: "text",
          message: rawMessage,
          encrypted: !1,
          messageId,
          sender: name
        });
      }

      dataChannel.send(payload);
      displayMessage(name, rawMessage, !0, "text", null, messageId, "sent");
      $("#chat-message").val("").focus();
    } catch (error) {
      console.error("Error sending text message:", error);
      showAlert("Failed to send message. Please try again.");
    }
  });

  $("#delete-all-btn").click(() => {
    console.log('🗑️ Global cleanup requested');
    fetch(SIGNALING_URL, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: "cleanup", peerId: "" }),
    }).then((res) => res.json())
      .then((result) => {
        console.log('✅ Global cleanup completed:', result);
        showAlert(`Deleted all SDP entries: ${result.message}`, !1);
        setTimeout(() => {
          location.reload();
        }, 3000);
      }).catch((err) => {
        console.error('❌ Global cleanup error:', err);
        showAlert(`Error deleting SDP entries: ${err}`);
      });
  });

  $("#joinPeer").click(async function (e) {
    e.preventDefault();
    isManuallyConnecting = !0;
    const username = $("#chat-username").val().trim();
    peerId = $("#peer-id").val().trim();
    $("#chat-username").prop("disabled", !0);
    $("#peer-id").prop("disabled", !0);
    $("#name-error").text("");
    $("#peer-error").text("");
    let hasError = !1;

    if (!username) {
      $("#name-error").text("Name is required");
      $("#chat-username").prop("disabled", !1);
      $("#peer-id").prop("disabled", !1);
      hasError = !0;
    }

    if (!peerId) {
      $("#peer-error").text("Peer ID is required");
      $("#chat-username").prop("disabled", !1);
      $("#peer-id").prop("disabled", !1);
      hasError = !0;
    }

    if (hasError) {
      return;
    }

    $("#joinPeer").prop("disabled", !0).text("Joining...");
    $("#peerIdSubmit").prop("disabled", !0).text("Connect");
    $("#peerId").val(peerId);
    $("#peerBtnGroup").removeClass("d-flex").addClass("d-none");
    $("#connectionStatusPanel").removeClass("d-none");
    updateConnectionStatus("Joining...", "5", !1);
    startConnection(peerId, "join");
  });

  $("#confirmSavePeerBtn").click(async () => {
    const peerIdInput = $("#peerIdToSave").val().trim();
    const peerNameInput = $("#peerNameToSave").val().trim();
    const alertBox = $("#save-peer-alert");
    alertBox.addClass("d-none").text("");

    if (!peerIdInput || !peerNameInput) {
      alertBox.text("Peer ID or Name cannot be empty").removeClass("d-none");
      return;
    }

    localStorage.setItem("peerIds", peerIdInput);
    localStorage.setItem("peerName", peerNameInput);
    showAlert(`Peer ID "${peerIdInput}" saved for notifications.`, !1);
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      alertBox.text("Notification permission denied. Cannot able to notify the joining request").removeClass("d-none");
      return;
    }

    $("#savePeerModal").modal("hide");
  });

  $("#settingBtn").click(function () {
    const savedPeers = localStorage.getItem("peerIds") || "";
    const savedPeersName = localStorage.getItem("peerName") || "";

    if (savedPeers) {
      $("#peerIdToSave").val(savedPeers);
      $("#peerNameToSave").val(savedPeersName);
    }

    loadApiKey();
  });

  let hasPrompted = !1;

  window.autoCheckInterval = setInterval(async () => {
    if (isManuallyConnecting || hasPrompted) return;

    const savedPeers = localStorage.getItem("peerIds") || "peer123";
    const savedPeerName = localStorage.getItem("peerName") || "Anonymous";

    if (!savedPeers) return;

    const offer = await fetchSDP(savedPeers, "offer");

    if (offer) {
      if (Notification.permission === "granted" && document.visibilityState !== "visible") {
        const notification = new Notification("Wavelite", {
          body: `Peer "${savedPeers}" is requesting to connect.`,
          icon: "/logo.png",
        });

        notification.onclick = function (event) {
          event.preventDefault();
          window.focus();
          $("#autoJoinMessage").text(`Peer "${savedPeers}" is requesting to connect. Do you want to join?`);
          const autoJoinModal = new bootstrap.Modal(document.getElementById("autoJoinModal"));
          autoJoinModal.show();

          $("#autoJoinConfirmBtn").off("click").on("click", () => {
            autoJoinModal.hide();
            setTimeout(() => {
              isManuallyConnecting = !0;
              $("#peer-id").val(savedPeers);
              $("#chat-username").val(savedPeerName);
              $("#joinPeer").click();
            }, 300);
          });
        };
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then((permission) => {
          if (permission === "granted" && document.visibilityState !== "visible") {
            new Notification("Wavelite", {
              body: `Peer "${savedPeers}" is requesting to connect.`,
              icon: "/logo.png",
            });
          }
        });
      }

      hasPrompted = !0;

      if (document.visibilityState === "visible") {
        $("#autoJoinMessage").text(`Peer "${savedPeers}" is requesting to connect. Do you want to join?`);
        const autoJoinModal = new bootstrap.Modal(document.getElementById("autoJoinModal"));
        autoJoinModal.show();

        $("#autoJoinConfirmBtn").off("click").on("click", () => {
          autoJoinModal.hide();
          setTimeout(() => {
            isManuallyConnecting = !0;
            $("#peer-id").val(savedPeers);
            $("#chat-username").val(savedPeerName);
            $("#joinPeer").click();
          }, 300);
        });
      }

      return;
    }
  }, 3000);

  /* ---- Secure Toggle ---- */
  $(document).on("click", "#secureToggleSwitch, #secureToggleBtn, #secureToggleTrack", function () {
    const newState = !secureEnabled;
    setSecureState(newState, !1);
    sendSecureState(newState);
  });

  /* ---- Override reload to reset navbar ---- */
  const origReloadClick = $("#reloadBtn").off("click");
  $("#reloadBtn").on("click", function () {
    updateNavbarForHome();
    location.reload();
  });

  /* ---- Override disconnect to reset navbar ---- */
  $(document).on("click", "#peerIdSubmit:contains('Disconnect')", function () {
    updateNavbarForHome();
  });

  /* ---- 3-Tap Gesture: Enable Developer Mode ---- */
  var devTapCount = 0, devTapTimer = null;
  $(document).on("click", ".landing-logo-text", function () {
    devTapCount++;
    if (devTapTimer) clearTimeout(devTapTimer);
    devTapTimer = setTimeout(function () { devTapCount = 0; }, 2000);
    if (devTapCount >= 3) {
      devTapCount = 0;
      var current = isDevModeEnabled();
      localStorage.setItem("wl_devMode", current ? "false" : "true");
      setDevMenuVisibility(!current);
      showAlert(current ? "Developer Mode Disabled" : "Developer Mode Enabled", !1);
    }
  });

  /* ---- Theme Initialization ---- */
  loadTheme();
  initDevMode();
  applySecureSyncTheme();

  /* ---- Color Picker ---- */
  $("#themeColorPicker").on("input", function () {
    var color = $(this).val();
    $("#themeColorValue").text(color);
    localStorage.setItem("wl_themeColor", color);
    applyThemeColor(color);
    applySecureSyncTheme();
    var st = document.getElementById('themeSaveStatus');
    if (st) { st.textContent = 'Theme applied'; setTimeout(function(){st.textContent='';},2000); }
  });

  /* ---- Reset Theme ---- */
  $("#resetThemeBtn").click(function () {
    resetTheme();
    applySecureSyncTheme();
  });

  /* ---- PostMessage listener (developer page cross-tab sync) ---- */
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "wl_devModeChanged") {
      setDevMenuVisibility(e.data.enabled);
    }
    if (e.data && e.data.type === "wl_secureSyncChanged") {
      applySecureSyncTheme();
    }
  });
});

async function startConnection(peerId, mode = "connect") {
  console.log(`🚀 Starting connection for peerId: ${peerId} (mode: ${mode})`);
  console.log(`🔍 Checking for existing offers...`);
  const offerEntry = await fetchSDP(peerId, "offer");
  console.log(`🔍 fetchSDP result:`, offerEntry);

  if (offerEntry && offerEntry.found) {
    console.log(`✅ Offer found for peerId: ${peerId}, acting as answerer`);
    console.log(`📦 Offer data:`, offerEntry);
    await setupAnswerer(offerEntry);
  } else {
    console.log(`❌ No offer found for peerId: ${peerId}, offerEntry:`, offerEntry);

    if (mode === "join") {
      console.log(`❌ No offer found for peerId: ${peerId}, starting to poll for offers (Join mode)`);
      startJoinConnection(peerId);
    } else {
      console.log(`❌ No offer found for peerId: ${peerId}, acting as offerer (Connect mode)`);
      await setupOfferer(peerId);
    }
  }
}

async function setupOfferer(peerId) {
  console.log(`🔄 Setting up offerer for peerId: ${peerId}`);
  localConnection = createPeerConnection();
  dataChannel = localConnection.createDataChannel("chat");
  mediaChannels = [];

  for (let i = 0; i < NUM_MEDIA_CHANNELS; i++) {
    const channel = localConnection.createDataChannel(`media-${i}`);
    setupMediaDataChannel(channel, i);
    mediaChannels.push(channel);
  }

  setupDataChannel();
  updateConnectionStatus("Offer Creating...", "10", !1);

  try {
    console.log("🔄 Creating offer...");
    const offer = await localConnection.createOffer();
    console.log("✅ Offer created successfully");
    console.log("📦 Offer SDP:", JSON.stringify(offer).substring(0, 100) + "...");
    await localConnection.setLocalDescription(offer);
    console.log("✅ Local offer description set successfully");
    console.log("⏳ Waiting for ICE gathering to complete...");
    await waitForIceGathering(localConnection);
    console.log("✅ ICE gathering completed");
    console.log(`📤 Submitting offer SDP for peerId: ${peerId}`);
    console.log("📦 Final offer SDP:", JSON.stringify(localConnection.localDescription).substring(0, 100) + "...");
    await submitSDP(peerId, "offer", JSON.stringify(localConnection.localDescription));
    console.log("✅ Offer SDP submitted successfully!");
    updateConnectionStatus("Waiting for peer...", "100", !0);

    let startTime = Date.now();
    let pollCount = 0;
    console.log(`⏰ Started polling for answers (timeout: ${CONNECTION_TIMEOUT / 1000}s, interval: 3s)`);

    pollingInterval = setInterval(async () => {
      pollCount++;
      const elapsed = Date.now() - startTime;
      console.log(`🔍 Poll #${pollCount} for answer (elapsed: ${Math.round(elapsed / 1000)}s)`);

      if (elapsed > CONNECTION_TIMEOUT) {
        console.log(`⏰ Connection timeout reached (${CONNECTION_TIMEOUT / 1000}s), stopping polling`);
        clearInterval(pollingInterval);
        $("#peerIdSubmit").prop("disabled", !1).text("Connect");
        $("#joinPeer").prop("disabled", !1).text("Join");
        showAlert("Connection timed out. Please try again or check peer ID.");
        $("#delete-all-btn").click();
        return;
      }

      const answerEntry = await fetchSDP(peerId, "answer");
      const percent = Math.min((elapsed / CONNECTION_TIMEOUT) * 100, 99);
      updateConnectionStatus("Waiting for peer...", percent, !0);

      if (answerEntry) {
        console.log(`✅ Answer SDP found for peerId: ${peerId} on poll #${pollCount}`);
        console.log(`🛑 Stopping polling for answers`);
        clearInterval(pollingInterval);

        try {
          console.log(`📦 Processing answer SDP...`);
          const sdp = JSON.parse(answerEntry.sdp);
          await localConnection.setRemoteDescription(new RTCSessionDescription(sdp));
          updateConnectionStatus("Connected Successfully!", "100", !0);
          console.log("✅ Remote description (answer) set successfully");
          console.log(`🎉 Connection established successfully!`);
          console.log(`🗑️ Cleaning up signaling data after successful connection`);
          deletePeerFromSheet(peerId);
        } catch (error) {
          console.error("❌ Failed to set remote description (answer):", error);
        }
      } else {
        console.log(`❌ No answer SDP found yet for peerId: ${peerId} (poll #${pollCount})`);
      }
    }, 4000);
  } catch (error) {
    console.error("Error setting up offerer:", error);
    $("#peerIdSubmit").prop("disabled", !1).text("Connect");
    $("#joinPeer").prop("disabled", !1).text("Join");
    showAlert("Failed to establish connection. Please try again.");
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
    console.log("Parsing and setting remote offer...");
    const offerSDP = JSON.parse(offerEntry.sdp);
    await localConnection.setRemoteDescription(new RTCSessionDescription(offerSDP));
    console.log("✅ Remote description (offer) set successfully");
    console.log("🔄 Creating answer...");
    const answer = await localConnection.createAnswer();
    console.log("✅ Answer created successfully");
    console.log("📦 Answer SDP:", JSON.stringify(answer).substring(0, 100) + "...");
    await localConnection.setLocalDescription(answer);
    console.log("✅ Local answer description set successfully");
    console.log("⏳ Waiting for ICE gathering to complete...");
    await waitForIceGathering(localConnection);
    console.log("✅ ICE gathering completed");
    console.log(`📤 Submitting answer SDP for peerId: ${offerEntry.peerId}`);
    console.log("📦 Final answer SDP:", JSON.stringify(localConnection.localDescription).substring(0, 100) + "...");
    await submitSDP(offerEntry.peerId, "answer", JSON.stringify(localConnection.localDescription));
    console.log("✅ Answer SDP submitted successfully!");
    console.log(`🗑️ Cleaning up offer data after submitting answer`);
    cleanupSignalingData(offerEntry.peerId, "offer");
  } catch (error) {
    console.error("❌ Error setting up answerer:", error);
    $("#peerIdSubmit").prop("disabled", !1).text("Connect");
    $("#joinPeer").prop("disabled", !1).text("Join");
    showAlert("Failed to establish connection. Please try again.");
  }
}

function createPeerConnection() {
  const stunEnabled = localStorage.getItem("wl_stunEnabled") !== "false";
  const turnEnabled = localStorage.getItem("wl_turnEnabled") !== "false";
  const iceServers = [];

  if (stunEnabled) {
    const savedStuns = JSON.parse(localStorage.getItem("selectedStunServers") || "[]");
    const stunServers = savedStuns.length >= 1 ? savedStuns : ["stun:global.stun.twilio.com:3478"];
    stunServers.forEach(function (url) { iceServers.push({ urls: url }); });
  }

  if (turnEnabled) {
    const savedTurnUrl = localStorage.getItem("turnServerUrl") || "";
    if (savedTurnUrl) {
      const turnConfig = { urls: savedTurnUrl };
      const savedTurnUser = localStorage.getItem("turnServerUser") || "";
      const savedTurnPass = localStorage.getItem("turnServerPass") || "";
      if (savedTurnUser && savedTurnPass) {
        turnConfig.username = savedTurnUser;
        turnConfig.credential = savedTurnPass;
      }
      iceServers.push(turnConfig);
    }
  }

  if (iceServers.length === 0) {
    iceServers.push({ urls: "stun:global.stun.twilio.com:3478" });
  }

  const pc = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 0,
  });

  isUsingRelay = !1;

  pc.onicecandidate = (e) => {
    if (e.candidate && e.candidate.candidate) {
      if (e.candidate.candidate.indexOf("typ relay") !== -1) {
        isUsingRelay = !0;
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", pc.iceConnectionState);
    const $status = $("#status");

    if (["connected", "completed"].includes(pc.iceConnectionState)) {
      $status.text("Online");
    } else if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
      $status.text("Offline");
    }
  };

  return pc;
}

function waitForIceGathering(pc) {
  updateConnectionStatus("ICE Gathering...", "80", !1);
  return new Promise((resolve) => {
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
  updateConnectionStatus(`Submitting ${role}...`, "90", !1);

  try {
    console.log(`📤 Submitting ${role} SDP for peerId: ${peerId}`);
    console.log(`📦 SDP data: ${sdp.substring(0, 100)}...`);
    const response = await fetch(SIGNALING_URL, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: role, peerId: peerId, data: sdp }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log(`✅ Submitted ${role} SDP for peerId: ${peerId}`, result);
    updateConnectionStatus(`${role} Submitted`, "99", !1);
  } catch (error) {
    console.error(`❌ Error submitting ${role} SDP:`, error);
    throw error;
  }
}

async function fetchSDP(peerId, role) {
  try {
    console.log(`📥 Fetching ${role} SDP for peerId: ${peerId}`);
    const url = `${SIGNALING_URL}?type=${encodeURIComponent(role)}&peerId=${encodeURIComponent(peerId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        'Content-Type': 'application/json'
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log(`📦 fetchSDP response:`, result);

    if (result.found) {
      console.log(`✅ Found ${role} SDP for peerId: ${peerId}`);
      console.log(`📦 SDP data: ${result.data.substring(0, 100)}...`);
      const returnData = {
        peerId: result.peerId,
        role: role,
        sdp: result.data,
        timestamp: result.timestamp,
        found: !0,
      };
      console.log(`📤 Returning:`, returnData);
      return returnData;
    } else {
      console.log(`❌ No ${role} SDP found for peerId: ${peerId}`);
      console.log(`📤 Returning null`);
      return null;
    }
  } catch (e) {
    console.error(`❌ Failed to fetch ${role} SDP for peerId: ${peerId}:`, e);
    return null;
  }
}

async function callEncode(dictionary, shift, message) {
  try {
    const res = await fetch(ENCODE_DECODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'encode', dictionary, shift, message })
    });
    const data = await res.json();
    if (data.encoded !== undefined) return data.encoded;
    console.error('Encode failed:', res.status, data.error, data.details || '');
    throw new Error(data.error || 'Encode failed');
  } catch (e) {
    console.error('Encode error:', e.message);
    return null;
  }
}

async function callDecode(dictionary, shift, message) {
  try {
    const res = await fetch(ENCODE_DECODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'decode', dictionary, shift, message })
    });
    const data = await res.json();
    if (data.decoded !== undefined) return data.decoded;
    console.error('Decode failed:', res.status, data.error, data.details || '');
    throw new Error(data.error || 'Decode failed');
  } catch (e) {
    console.error('Decode error:', e.message);
    return null;
  }
}

/* ---- Color utilities for theme system ---- */
function hexToHsl(hex) {
  let r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  let max=Math.max(r,g,b), min=Math.min(r,g,b), h,s,l=(max+min)/2;
  if(max===min) { h=s=0; } else {
    let d=max-min;
    s=l>0.5?d/(2-max-min):d/(max+min);
    switch(max){case r: h=((g-b)/d+(g<b?6:0))/6; break; case g: h=((b-r)/d+2)/6; break; case b: h=((r-g)/d+4)/6; break;}
  }
  return { h:Math.round(h*360), s:Math.round(s*100), l:Math.round(l*100) };
}

function hslToHex(h,s,l) {
  s/=100; l/=100;
  let c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs((h/60)%2-1)), m=l-c/2, r,g,b;
  if(h<60){r=c;g=x;b=0}else if(h<120){r=x;g=c;b=0}else if(h<180){r=0;g=c;b=x}else if(h<240){r=0;g=x;b=c}else if(h<300){r=x;g=0;b=c}else{r=c;g=0;b=x}
  let toHex=(n)=>Math.round((n+m)*255).toString(16).padStart(2,'0');
  return '#'+toHex(r)+toHex(g)+toHex(b);
}

function lightenColor(hex,amt){
  let hsl=hexToHsl(hex);
  hsl.l=Math.min(100,hsl.l+amt);
  return hslToHex(hsl.h,hsl.s,hsl.l);
}

function darkenColor(hex,amt){
  let hsl=hexToHsl(hex);
  hsl.l=Math.max(0,hsl.l-amt);
  return hslToHex(hsl.h,hsl.s,hsl.l);
}

function shiftHue(hex,deg){
  let hsl=hexToHsl(hex);
  hsl.h=(hsl.h+deg+360)%360;
  return hslToHex(hsl.h,hsl.s,hsl.l);
}

/* ---- Theme system ---- */
function applyThemeColor(baseHex) {
  wlCustomThemeColor = baseHex;
  const root = document.documentElement;
  const blue = baseHex || WL_DEFAULT_BLUE;

  let finalBlue = blue, finalCyan = WL_DEFAULT_CYAN;
  if (wlSecureSyncActive) {
    finalBlue = shiftHue(blue, 15);
    finalCyan = shiftHue(WL_DEFAULT_CYAN, 15);
  }

  root.style.setProperty('--wl-blue', finalBlue);
  root.style.setProperty('--wl-blue-light', lightenColor(finalBlue, 8));
  root.style.setProperty('--wl-blue-soft', lightenColor(finalBlue, 42));
  root.style.setProperty('--wl-blue-pale', lightenColor(finalBlue, 62));
  root.style.setProperty('--wl-blue-bg', finalBlue + '14');
  root.style.setProperty('--wl-blue-hover', darkenColor(finalBlue, 10));
  root.style.setProperty('--wl-cyan', finalCyan);
  root.style.setProperty('--wl-cyan-soft', lightenColor(finalCyan, 38));
  root.style.setProperty('--wl-shadow-blue', `0 8px 32px ${finalBlue}29`);

  const picker = document.getElementById('themeColorPicker');
  const value = document.getElementById('themeColorValue');
  if (picker) picker.value = baseHex || WL_DEFAULT_BLUE;
  if (value) value.textContent = baseHex || WL_DEFAULT_BLUE;
}

function resetTheme() {
  localStorage.removeItem('wl_themeColor');
  wlCustomThemeColor = null;
  applyThemeColor(WL_DEFAULT_BLUE);
  const status = document.getElementById('themeSaveStatus');
  if (status) { status.textContent = 'Theme reset to default'; setTimeout(function(){status.textContent='';},2000); }
}

function loadTheme() {
  const saved = localStorage.getItem('wl_themeColor');
  applyThemeColor(saved || WL_DEFAULT_BLUE);
}

/* ---- Developer Mode ---- */
function isDevModeEnabled() {
  return localStorage.getItem('wl_devMode') === 'true';
}

function setDevMenuVisibility(show) {
  const item = document.getElementById('devMenuItem');
  const divider = document.getElementById('devMenuDivider');
  if (item) item.classList.toggle('d-none', !show);
  if (divider) divider.classList.toggle('d-none', !show);
}

function initDevMode() {
  setDevMenuVisibility(isDevModeEnabled());
}

/* ---- Secure Sync Preference ---- */
function isSecureSyncEnabled() {
  return localStorage.getItem('wl_secureSync') !== 'false';
}

function applySecureSyncTheme() {
  wlSecureSyncActive = isSecureSyncEnabled();
  applyThemeColor(wlCustomThemeColor || localStorage.getItem('wl_themeColor') || WL_DEFAULT_BLUE);
}

function setupDataChannel() {
  if (!peerId) {
    console.error("peerId is undefined in setupDataChannel");
    return;
  }

  dataChannel.onopen = () => {
    console.log("Data channel opened for peerId:", peerId);
    deletePeerFromSheet(peerId);

    pingIntervalId = setInterval(() => {
      if (dataChannel.readyState === "open") {
        dataChannel.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, PING_INTERVAL);

    dataChannel.send(JSON.stringify({
      type: "username",
      name: truncateName($("#chat-username").val() || "Anonymous"),
    }));
    transitionToChat();
  };

  dataChannel.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      const view = new Uint32Array(e.data, 0, 4);
      const [transferIndex, majorIndex, chunkIndex, totalChunks] = view;
      const messageId = receiverTransferIndexMap.get(transferIndex);

      if (!messageId) {
        console.warn("Received chunk for unknown transferIndex:", transferIndex);
        return;
      }

      const transfer = receivedTransfers.get(messageId);

      if (!transfer) {
        console.warn("Received chunk but no file info available yet.");
        return;
      }

      const chunkData = e.data.slice(16);
      transfer.buffers.push(chunkData);
      transfer.receivedBytes += chunkData.byteLength;
      transfer.expectedChunk++;
      updateProgressBar(messageId, (transfer.receivedBytes / transfer.fileInfo.fileSize) * 100);

      if (transfer.receivedBytes >= transfer.fileInfo.fileSize) {
        clearTimeout(transfer.timeoutId);

        try {
          const blob = new Blob(transfer.buffers, {
            type: transfer.fileInfo.fileType || "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          displayMessage(
            transfer.fileInfo.name,
            transfer.fileInfo.fileName,
            !1,
            "file",
            url,
            messageId,
            "delivered",
            transfer.fileInfo.fileType,
            transfer.fileInfo.fileSize
          );
        } catch (err) {
          console.error(`Error reconstructing file ${transfer.fileInfo.fileName}:`, err);
          showAlert("Failed to reconstruct received file.");
        }

        hideProgressBar(messageId);
        receivedTransfers.delete(messageId);
        retryCounts.delete(messageId);
        if (transfer.transferIndex) receiverTransferIndexMap.delete(transfer.transferIndex);
        if (currentReceivingMessageId === messageId) currentReceivingMessageId = null;
        try { dataChannel.send(JSON.stringify({ type: "file_ack", messageId })); } catch (e) {}
        var nextWaiting = document.querySelector('[data-status="waiting"]');
        if (nextWaiting) {
          var nextMid = nextWaiting.getAttribute('data-message-id');
          nextWaiting.setAttribute('data-status', 'receiving');
          showProgressBar(nextMid, !1);
        }
      } else {
        clearTimeout(transfer.timeoutId);
        transfer.timeoutId = setTimeout(() => {
          const retryCount = retryCounts.get(messageId) || 0;

          if (retryCount < MAX_RETRIES) {
            console.warn(`Resend request: ${messageId} [${majorIndex}-${transfer.expectedChunk}]`);
            retryCounts.set(messageId, retryCount + 1);
            dataChannel.send(JSON.stringify({
              type: "resend_request",
              messageId,
              majorIndex,
              chunkIndex: transfer.expectedChunk,
            }));
          } else {
            showAlert(`Failed to receive all chunks for ${transfer.fileInfo.fileName}.`);
            hideProgressBar(messageId);
            receivedTransfers.delete(messageId);
            retryCounts.delete(messageId);
            if (transfer.transferIndex) receiverTransferIndexMap.delete(transfer.transferIndex);
          }
        }, CHUNK_TIMEOUT);
      }
    } else {
      const msg = JSON.parse(e.data);

      if (msg.type === "text") {
        const sender = msg.sender || msg.name || "Peer";
        (async () => {
          let displayText = msg.message;
          let encryptedMeta = null;

          if (msg.encrypted && msg.meta) {
            if (secureEnabled) {
              const decoded = await callDecode(msg.meta.dictionary, msg.meta.shift, msg.message);
              if (decoded !== null) {
                displayText = decoded;
              } else {
                displayText = "[Decryption failed — message cannot be displayed]";
              }
            } else {
              encryptedMeta = msg.meta;
            }
          }
          displayMessage(sender, displayText, !1, "text", null, msg.messageId, "delivered", null, null, encryptedMeta);
        })();
      } else if (msg.type === "secure_state") {
        setSecureState(msg.enabled, !0);
      } else if (msg.type === "location") {
        displayMessage(msg.name || "Peer", msg, !1, "location", null, msg.messageId, "delivered");
      } else if (msg.type === "file") {
        receivedTransfers.set(msg.messageId, {
          fileInfo: {
            name: msg.name,
            messageId: msg.messageId,
            fileName: msg.fileName,
            fileSize: msg.fileSize,
            fileType: msg.fileType,
            useSingleChannel: msg.useSingleChannel || !1,
          },
          buffers: [],
          receivedBytes: 0,
          expectedChunk: 0,
          lastChunkTime: Date.now(),
          timeoutId: null,
          transferIndex: msg.transferIndex || null,
        });

        if (msg.transferIndex) {
          receiverTransferIndexMap.set(msg.transferIndex, msg.messageId);
        }

        if (!msg.useSingleChannel) {
          mediaReceivingChunks[msg.messageId] = {
            fileInfo: {
              name: msg.name,
              fileName: msg.fileName,
              fileSize: msg.fileSize,
              fileType: msg.fileType,
            },
            parts: new Array(NUM_MEDIA_CHANNELS),
            bytesReceived: 0,
            expectedSize: msg.fileSize,
            completed: !1,
            transferIndex: msg.transferIndex || null,
          };
        }

        var isSender = !1;
        var isWaiting = currentReceivingMessageId !== null && currentReceivingMessageId !== msg.messageId;
        var statusLabel = isWaiting ? 'Waiting...' : 'Receiving...';
        var placeholderHtml = '<div class="chat-message other px-3" data-message-id="' + msg.messageId + '" data-status="' + (isWaiting ? 'waiting' : 'receiving') + '">' +
          '<div class="message py-1 d-flex align-items-center" style="font-size:12px;font-weight:450;">' +
          '<div class="file-icon-box" style="width:40px;height:40px;min-width:40px;border-radius:6px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;"><i class="fas fa-file text-dark fs-4"></i></div>' +
          '<div class="file-text-block ms-2">' +
          '<div class="file-name" style="font-size: 13px; font-weight: 500;">' + (msg.fileName || 'Receiving file...') + '</div>' +
          '<div class="file-name file-status" style="font-size: 10px;font-weight:500;">' + statusLabel + '</div>' +
          '</div></div></div>';
        $("#chat-display").append(placeholderHtml);

        if (!isWaiting) {
          currentReceivingMessageId = msg.messageId;
          showProgressBar(msg.messageId, isSender);
        }
        console.log(`Received file metadata for ${msg.fileName}`);
      } else if (msg.type === "resend_request") {
        console.log(`🔁 Resend request for ${msg.messageId} [${msg.majorIndex}-${msg.chunkIndex}]`);
        resendFileChunk(msg.messageId, msg.majorIndex, msg.chunkIndex);
      } else if (msg.type === "file_ack") {
        console.log(`✅ Received file_ack for messageId: ${msg.messageId}`);
        if (ackSafetyTimeouts.has(msg.messageId)) {
          clearTimeout(ackSafetyTimeouts.get(msg.messageId));
          ackSafetyTimeouts.delete(msg.messageId);
        }
        hideProgressBar(msg.messageId);
        $("#chat-file").val("");
        $("#btn-toggle-back").click();
        currentFile = null;
        activeTransfers.delete(msg.messageId);
        retryCounts.delete(msg.messageId);
        isSendingFile = !1;
        processNextFileInQueue();
      } else if (msg.type === "username") {
        console.log("Received peer username:", msg.name);
        $("#headerBtnName").text(msg.name).addClass("text-capitalize");
      } else if (msg.type === "ping") {
        console.log(`📡 Ping received from peer at ${new Date(
          msg.timestamp
        ).toLocaleTimeString()}`);
        $("#status").text("Online");
        lastPingReceivedTime = Date.now();
      }
    }
  };

  dataChannel.onerror = (error) => {
    console.error("Data channel error:", error);

    for (const [messageId, transfer] of receivedTransfers.entries()) {
      hideProgressBar(messageId);
      showAlert(`Transfer error for ${transfer.fileInfo.fileName}. Please try again.`);
      clearTimeout(transfer.timeoutId);
      retryCounts.delete(messageId);
      if (transfer.transferIndex) receiverTransferIndexMap.delete(transfer.transferIndex);
    }

    receivedTransfers.clear();
    pendingSendBatch = [];
    ackSafetyTimeouts.forEach(function(t) { clearTimeout(t); });
    ackSafetyTimeouts.clear();
    isSendingFile = !1;
    currentReceivingMessageId = null;
  };
}

function setupMediaDataChannel(channel, index) {
  channel.onmessage = (e) => {
    const data = new Uint8Array(e.data);
    const metadata = new Uint32Array(data.slice(0, 16).buffer);
    const transferIndex = metadata[0];
    const majorIndex = metadata[1];
    const chunkIndex = metadata[2];
    const totalChunks = metadata[3];
    const payload = data.slice(16);

    const messageId = receiverTransferIndexMap.get(transferIndex);

    if (!messageId) {
      console.warn("Received multi-channel chunk for unknown transferIndex:", transferIndex);
      return;
    }

    const transfer = mediaReceivingChunks[messageId];

    if (!transfer) {
      console.warn("Received chunk but no file info available yet for messageId:", messageId);
      return;
    }

    if (!transfer.parts[majorIndex]) {
      transfer.parts[majorIndex] = new Array(totalChunks).fill(null);
    }

    if (!transfer.parts[majorIndex][chunkIndex]) {
      transfer.parts[majorIndex][chunkIndex] = payload;
      transfer.bytesReceived += payload.byteLength;
    }

    if (!transfer.lastReceivedTime) transfer.lastReceivedTime = {};
    transfer.lastReceivedTime[`${majorIndex}-${chunkIndex}`] = Date.now();

    if (!transfer.resendIntervalId) {
      transfer.resendIntervalId = setInterval(() => {
        const allChunksPresent = transfer.parts.every(
          (part) => part && part.every((c) => c)
        );

        if (!allChunksPresent) {
          for (let m = 0; m < transfer.parts.length; m++) {
            if (!Array.isArray(transfer.parts[m])) continue;

            for (let c = 0; c < transfer.parts[m].length; c++) {
              if (!transfer.parts[m][c]) {
                console.warn(`⏳ Missing chunk detected: [${m}-${c}] for messageId ${messageId}`);
                dataChannel.send(JSON.stringify({
                  type: "resend_request",
                  messageId,
                  majorIndex: m,
                  chunkIndex: c,
                }));
                return;
              }
            }
          }
        }
      }, CHUNK_TIMEOUT);
    }

    updateProgressBar(messageId, (transfer.bytesReceived / transfer.expectedSize) * 100);

    const isComplete =
      transfer.parts.length === 3 &&
      transfer.parts.every(
        (part) =>
          Array.isArray(part) &&
          part.length === totalChunks &&
          part.every((chunk) => chunk !== null && chunk !== undefined)
      );

    if (!isComplete) {
      console.warn(`❗ File assembly attempted before all chunks arrived. Parts:`, transfer.parts);
      return;
    }

    clearInterval(transfer.resendIntervalId);
    delete transfer.resendIntervalId;
    transfer.completed = !0;

    const blobParts = transfer.parts.flat();
    const finalBlob = new Blob(blobParts, { type: transfer.fileInfo.fileType });
    const url = URL.createObjectURL(finalBlob);

    displayMessage(
      transfer.fileInfo.name,
      transfer.fileInfo.fileName,
      !1,
      "file",
      url,
      messageId,
      "delivered",
      transfer.fileInfo.fileType,
      transfer.fileInfo.fileSize
    );
    hideProgressBar(messageId);
    delete mediaReceivingChunks[messageId];
    if (transfer.transferIndex) receiverTransferIndexMap.delete(transfer.transferIndex);
    if (currentReceivingMessageId === messageId) currentReceivingMessageId = null;
    try { dataChannel.send(JSON.stringify({ type: "file_ack", messageId })); } catch (e) {}
    var nextWaiting = document.querySelector('[data-status="waiting"]');
    if (nextWaiting) {
      var nextMid = nextWaiting.getAttribute('data-message-id');
      nextWaiting.setAttribute('data-status', 'receiving');
      showProgressBar(nextMid, !1);
    }
  };

  channel.onerror = (err) => {
    console.error("Media channel error (index " + index + "):", err);
    $("#status").text("Offline");
    showPeerOfflineModal();
  };

  channel.onopen = () => {
    console.log("Media data channel " + index + " opened");
  };
}

function sendFileChunks(messageId) {
  const transfer = activeTransfers.get(messageId);
  if (!transfer) return;

  if (transfer.useSingleChannel) {
    const channel = dataChannel;

    if (!channel) {
      console.warn("No open media channel available.");
      showAlert("No media channel available to send the file.");
      return;
    }

    const totalChunks = Math.ceil(transfer.file.size / CHUNK_SIZE);
    let sentChunks = 0;
    let progressUpdated = 0;
    let currentChunk = 0;

    const sendChunk = () => {
      if (currentChunk >= totalChunks) {
        console.log("✅ File sending complete (single channel) for messageId:", messageId);
        updateProgressBar(messageId, 99);
        var progressEl = document.querySelector('#progress-' + messageId + ' .progress-percentage');
        if (progressEl) progressEl.textContent = 'Finalizing...';
        ackSafetyTimeouts.set(messageId, setTimeout(() => {
          console.warn("ACK timeout for messageId:", messageId);
          ackSafetyTimeouts.delete(messageId);
          hideProgressBar(messageId);
          activeTransfers.delete(messageId);
          retryCounts.delete(messageId);
          isSendingFile = !1;
          processNextFileInQueue();
        }, ACK_TIMEOUT));
        return;
      }

      if (channel.bufferedAmount > 4 * 1024 * 1024) {
        setTimeout(sendChunk, 100);
        return;
      }

      const start = currentChunk * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
      const slice = transfer.file.slice(start, end);
      const reader = new FileReader();

      reader.onload = () => {
        try {
          const meta = new Uint32Array([transfer.transferIndex, 0, currentChunk, totalChunks]);
          const data = new Uint8Array(reader.result);
          const combined = new Uint8Array(meta.byteLength + data.byteLength);
          combined.set(new Uint8Array(meta.buffer), 0);
          combined.set(data, meta.byteLength);
          channel.send(combined.buffer);
          sentChunks++;
          const percentage = (sentChunks / totalChunks) * 100;

          if (percentage - progressUpdated >= 1) {
            progressUpdated = percentage;
            updateProgressBar(messageId, percentage);
          }

          currentChunk++;
          setTimeout(sendChunk, 0);
        } catch (err) {
          console.error("❌ Error sending chunk:", err);
          hideProgressBar(messageId);
          showAlert("Failed to send chunk.");
          activeTransfers.delete(messageId);
          retryCounts.delete(messageId);
          isSendingFile = !1;
          processNextFileInQueue();
        }
      };

      reader.onerror = () => {
        console.error("❌ FileReader error during send");
        hideProgressBar(messageId);
        showAlert("Failed to read file chunk.");
        activeTransfers.delete(messageId);
        retryCounts.delete(messageId);
        isSendingFile = !1;
        processNextFileInQueue();
      };

      reader.readAsArrayBuffer(slice);
    };

    sendChunk();
    return;
  }

  const file = transfer.file;
  const fileSize = file.size;
  const chunkSize = CHUNK_SIZE;
  const numChannels = mediaChannels.length;
  const partSize = Math.ceil(fileSize / numChannels);
  const chunkParts = [];

  for (let i = 0; i < numChannels; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, fileSize);
    chunkParts[i] = [];

    for (let offset = start; offset < end; offset += chunkSize) {
      const slice = file.slice(offset, Math.min(offset + chunkSize, end));
      chunkParts[i].push(slice);
    }
  }

  transfer.chunkParts = chunkParts;
  const totalSubChunks = chunkParts.flat().length;
  let totalSentChunks = 0;
  let progressUpdated = 0;

  chunkParts.forEach((partChunks, majorIndex) => {
    let subIndex = 0;

    const sendNext = () => {
      if (subIndex >= partChunks.length) return;

      const channel = mediaChannels[majorIndex];

      if (!channel || channel.readyState !== "open") {
        console.warn(`Channel ${majorIndex} not ready`);
        setTimeout(sendNext, 100);
        return;
      }

      if (channel.bufferedAmount > 4 * 1024 * 1024) {
        setTimeout(sendNext, 100);
        return;
      }

      const reader = new FileReader();

      reader.onload = () => {
        try {
          const meta = new Uint32Array([transfer.transferIndex, majorIndex, subIndex, partChunks.length]);
          const data = new Uint8Array(reader.result);
          const combined = new Uint8Array(meta.byteLength + data.byteLength);
          combined.set(new Uint8Array(meta.buffer), 0);
          combined.set(data, meta.byteLength);
          channel.send(combined.buffer);
          totalSentChunks++;
          const percentage = (totalSentChunks / totalSubChunks) * 100;

          if (percentage - progressUpdated >= 1) {
            progressUpdated = percentage;
            updateProgressBar(messageId, percentage);
          }

          subIndex++;
          setTimeout(sendNext, 0);
        } catch (err) {
          console.error("❌ Send error:", err);
          hideProgressBar(messageId);
          showAlert("Failed to send chunk");
          activeTransfers.delete(messageId);
          retryCounts.delete(messageId);
          isSendingFile = !1;
          processNextFileInQueue();
        }
      };

      reader.onerror = () => {
        console.error("❌ FileReader error");
        hideProgressBar(messageId);
        showAlert("Failed to read chunk");
        activeTransfers.delete(messageId);
        retryCounts.delete(messageId);
        isSendingFile = !1;
        processNextFileInQueue();
      };

      reader.readAsArrayBuffer(partChunks[subIndex]);
    };

    sendNext();
  });

  const checkComplete = setInterval(() => {
    if (totalSentChunks >= totalSubChunks) {
      clearInterval(checkComplete);
      console.log("✅ File sending complete for messageId:", messageId);
      updateProgressBar(messageId, 99);
      var progressEl = document.querySelector('#progress-' + messageId + ' .progress-percentage');
      if (progressEl) progressEl.textContent = 'Finalizing...';
      ackSafetyTimeouts.set(messageId, setTimeout(() => {
        console.warn("ACK timeout for messageId:", messageId);
        ackSafetyTimeouts.delete(messageId);
        hideProgressBar(messageId);
        activeTransfers.delete(messageId);
        retryCounts.delete(messageId);
        isSendingFile = !1;
        processNextFileInQueue();
      }, ACK_TIMEOUT));
    }
  }, 300);
}

function resendFileChunk(messageId, majorIndex, chunkIndex) {
  const transfer = activeTransfers.get(messageId);

  if (!transfer || !transfer.chunkParts) {
    console.warn(`Cannot resend chunk: missing transfer info or chunkParts`);
    return;
  }

  const partChunks = transfer.chunkParts[majorIndex];

  if (!partChunks || !partChunks[chunkIndex]) {
    console.warn(`Chunk not found for resend: major ${majorIndex}, index ${chunkIndex}`);
    return;
  }

  const channel = mediaChannels[majorIndex];

  if (!channel || channel.readyState !== "open") {
    console.warn(`Channel ${majorIndex} not ready for resend`);
    setTimeout(() => resendFileChunk(messageId, majorIndex, chunkIndex), 200);
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const meta = new Uint32Array([transfer.transferIndex, majorIndex, chunkIndex, partChunks.length]);
      const data = new Uint8Array(reader.result);
      const combined = new Uint8Array(meta.byteLength + data.byteLength);
      combined.set(new Uint8Array(meta.buffer), 0);
      combined.set(data, meta.byteLength);
      channel.send(combined.buffer);
      console.log(`✅ Resent chunk [${majorIndex}-${chunkIndex}] for messageId: ${messageId}`);
    } catch (error) {
      console.error(`❌ Resend failed:`, error);
    }
  };

  reader.onerror = () => {
    console.error(`❌ FileReader error during resend for [${majorIndex}-${chunkIndex}]`);
  };

  reader.readAsArrayBuffer(partChunks[chunkIndex]);
}

function showProgressBar(messageId, isSender) {
  const alignClass = isSender ? "self" : "other";
  let fileName = "Unknown File";

  if (isSender) {
    fileName = activeTransfers.get(messageId)?.fileName || "Unknown File";
  } else if (mediaReceivingChunks[messageId]?.fileInfo?.fileName) {
    fileName = mediaReceivingChunks[messageId].fileInfo.fileName;
  } else if (receivedTransfers.get(messageId)?.fileInfo?.fileName) {
    fileName = receivedTransfers.get(messageId).fileInfo.fileName;
  }

  $("#chat-display").append(`
    <div class="chat-message ${alignClass} px-3" id="progress-${messageId}">
      <div class="file-name mt-2" style="font-size: 14px; font-weight: 500;">${truncateName(
        fileName,
        25
      )}</div>
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
  $("#chat-display").scrollTop($("#chat-display")[0].scrollHeight);
}

function updateProgressBar(messageId, percentage) {
  const roundedPercentage = Math.min(100, Math.round(percentage));
  $(`#progress-${messageId} .progress-bar`)
    .css("width", `${roundedPercentage}%`)
    .attr("aria-valuenow", roundedPercentage)
    .find(".progress-percentage")
    .text(`${roundedPercentage}%`);
}

function hideProgressBar(messageId) {
  $(`#progress-${messageId}`).remove();
}

function showQueuedProgress(fakeId, fileName) {
  $("#chat-display").append(`
    <div class="chat-message self px-3" id="${fakeId}">
      <div class="file-name mt-2" style="font-size: 14px; font-weight: 500;">${truncateName(
        fileName,
        25
      )}</div>
      <div class="progress mt-2" style="height: 30px;">
        <div class="progress-bar bg-secondary text-white" 
             style="width: 100%; font-size: 14px; line-height: 30px;">
          Queued...
        </div>
      </div>
    </div>
  `);
  $("#chat-display").scrollTop($("#chat-display")[0].scrollHeight);
}

function transitionToChat() {
  $("#ai-btn").addClass("d-none");

  if ($("#chat-section").hasClass("d-none")) {
    $("#login-section").removeClass("d-flex").addClass("d-none");
    $("#chat-section").removeClass("d-none");
    $("#peerIdSubmit").prop("disabled", !1).text("Disconnect");
    updateNavbarForChat();
    console.log("Transitioned to chat UI");
  }
}

function displayMessage(name, content, isSelf, type, file, messageId, status, fileType = null, fileSize = null, encryptedMeta = null) {
  const alignClass = isSelf ? "self" : "other";
  const statusIcon = isSelf
    ? `<span class="status-icon  ms-2" style="color: var(--wl-neon);"><i class="fas fa-check-double"></i></span>`
    : "";
  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  let messageContent = content;

  if (type === "text") {
    messageContent = formatTextMsg(content);
  } else if (type === "location") {
    const obj = typeof content === "string" ? JSON.parse(content) : content;
    const shortUrl = obj.url;
    messageContent = `
      <div class="card shadow-sm border-0">
        <div class="ratio ratio-16x9">
          <iframe class="rounded" src="https://maps.google.com/maps?q=${obj.lat},${obj.lng}&z=15&output=embed" frameborder="0"></iframe>
        </div>
        <div class="p-2">
          <div class="fw-bold mb-1 text-truncate">${shortUrl}</div>
          <a href="${shortUrl}" target="_blank" class="btn btn-sm btn-outline-primary w-100"><i class="fas fa-map-pin me-1"></i> Go to</a>
        </div>
      </div>`;
  } else if (type === "file" && file) {
    const isImage = fileType && fileType.startsWith("image/");
    const isAudio = fileType && fileType.startsWith("audio/");
    const isVideo = fileType && fileType.startsWith("video/");

    const downloadButton = `<a href="${file}" download="${content}" class="btn btn-sm btn-secondary w-100 mt-2 d-block"><i class="fas fa-download me-2"></i>Download</a>`;
    const fileNameDisplay = `<div class="file-name" style="font-size: 13px; font-weight: 500;">${truncateName(
      content,
      25
    )}</div>`;
    const fileSizeAndType = `<div class="file-name" style="font-size: 10px;font-weight:500;">${formatBytes(
      fileSize
    )} • <span class="text-uppercase">${content.slice(
      content.lastIndexOf(".") + 1
    )}</span></div>`;

    if (isImage) {
      messageContent = `
      <div class="image-wrapper" style="width: 220px; height: 220px; overflow: hidden; border-radius: 8px;">
        <img src="${file}" alt="${content}" class="chat-thumb mt-2" style="width: 100%; height: 100%; object-fit: cover; display: block;" />
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
          waveColor: "#ccc",
          progressColor: "#0d6efd",
          height: 80,
          responsive: !0,
        });
        wavesurfer.load(file);
        window[`player_${containerId}`] = wavesurfer;
      }, 100);
    } else if (isVideo) {
      messageContent = `
      <div class="plyr-wrapper rounded overflow-hidden mt-2" style="max-width: 100%;">
        <video id="player-${Date.now()}" class="plyr w-100" controls playsinline style="object-fit: contain; min-height: 300px;">
          <source src="${file}" type="video/webm" />
        </video>
      </div>
        <br>${fileNameDisplay} ${fileSizeAndType} ${downloadButton}`;
      setTimeout(() => {
        const players = Plyr.setup("video");
      }, 0);
    } else {
      let fileIconClass = "fa-file text-dark";

      if (fileType === "application/pdf") {
        fileIconClass = "fa-file-pdf text-danger";
      } else if (fileType.includes("word")) {
        fileIconClass = "fa-file-word text-primary";
      } else if (fileType === "application/vnd.ms-excel" || fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
        fileIconClass = "fa-file-excel text-success";
      } else if (fileType === "application/vnd.ms-powerpoint" || fileType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
        fileIconClass = "fa-file-powerpoint text-warning";
      } else if (fileType.includes("zip") || fileType.includes("rar")) {
        fileIconClass = "fa-file-archive text-muted";
      } else if (fileType.includes("text")) {
        fileIconClass = "fa-file-lines text-secondary";
      }

      messageContent = `<i class="fas ${fileIconClass} me-2 fs-4"></i> ${fileNameDisplay} ${fileSizeAndType} ${downloadButton}`;
    }
  }

  try {
    var existing = document.querySelector('[data-message-id="' + messageId + '"]');
    var encryptedAttrs = '';
    if (encryptedMeta) {
      encryptedAttrs = ' data-encrypted="true" data-dictionary="' + encryptedMeta.dictionary + '" data-shift="' + encryptedMeta.shift + '"';
    }
    var newBubble = $('<div class="chat-message ' + alignClass + ' px-3" data-message-id="' + messageId + '"' + encryptedAttrs + '>' +
      '<div class="message py-1" style="font-size:12px;font-weight:450;">' + messageContent + '</div>' +
      '<div class="message-meta d-flex justify-content-end border-top border-secondary mt-2">' +
      '<span class="timestamp text-end" style="font-size:10px;">' +
      (isSelf ? '' : '<span class="name" style="font-size:12px;"></span>') + ' ' + timestamp + ' ' + statusIcon +
      '</span></div></div>');

    if (existing) {
      existing.replaceWith(newBubble[0]);
    } else {
      $("#chat-display").append(newBubble);
    }
    $("#chat-display").scrollTop($("#chat-display")[0].scrollHeight);
    console.log(`Displayed message for ${type}: ${content}, fileType: ${
      fileType || "none"
    }`);
  } catch (error) {
    console.error(`Error displaying message for ${content}:`, error);
    showAlert("Failed to display message in UI. Please refresh the page.");
  }
}

function deletePeerFromSheet(peerId) {
  if (!peerId) {
    console.error("❌ peerId is undefined in deletePeerFromSheet");
    return;
  }

  console.log(`🗑️ Cleaning up signaling data for peerId: ${peerId}`);
  fetch(SIGNALING_URL, {
    method: "POST",
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: "cleanup", peerId: peerId }),
  }).then((res) => res.json())
    .then((result) => {
      console.log(`✅ Cleaned up signaling data for peerId: ${peerId}`, result);
    }).catch((err) => console.error(`❌ Cleanup error for peerId: ${peerId}:`, err));
}

function cleanupSignalingData(peerId, type) {
  if (!peerId) {
    console.error("❌ peerId is undefined in cleanupSignalingData");
    return;
  }

  console.log(`🗑️ Cleaning up ${type} data for peerId: ${peerId}`);
  fetch(SIGNALING_URL, {
    method: "POST",
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: "cleanup", peerId: peerId, cleanupType: type }),
  }).then((res) => res.json())
    .then((result) => {
      console.log(`✅ Cleaned up ${type} data for peerId: ${peerId}`, result);
    }).catch((err) => console.error(`❌ Cleanup error for ${type} peerId: ${peerId}:`, err));
}

async function startJoinConnection(peerId) {
  console.log(`🚀 Starting join connection for peerId: ${peerId}`);
  updateConnectionStatus("Waiting for offer...", "10", !1);

  let startTime = Date.now();
  let pollCount = 0;

  pollingInterval = setInterval(async () => {
    pollCount++;
    const elapsed = Date.now() - startTime;
    console.log(`🔍 Poll #${pollCount} for offer (elapsed: ${Math.round(elapsed / 1000)}s)`);

    if (elapsed > CONNECTION_TIMEOUT) {
      console.log(`⏰ Connection timeout reached (${CONNECTION_TIMEOUT / 1000}s), stopping polling`);
      clearInterval(pollingInterval);
      $("#joinPeer").prop("disabled", !1).text("Join");
      $("#peerIdSubmit").prop("disabled", !1).text("Connect");
      showAlert("No offer found. Please try again or check peer ID.");
      return;
    }

    const offerEntry = await fetchSDP(peerId, "offer");
    const percent = Math.min((elapsed / CONNECTION_TIMEOUT) * 100, 99);
    updateConnectionStatus("Waiting for offer...", percent, !0);

    if (offerEntry) {
      console.log(`✅ Offer SDP found for peerId: ${peerId} on poll #${pollCount}`);
      console.log(`🛑 Stopping polling for offers`);
      clearInterval(pollingInterval);

      try {
        console.log(`🔄 Proceeding as answerer...`);
        await setupAnswerer(offerEntry);
        updateConnectionStatus("Joined Successfully", "100", !0);
        console.log(`🎉 Join connection completed successfully!`);
      } catch (error) {
        console.error("❌ Error during join connection:", error);
        $("#joinPeer").prop("disabled", !1).text("Join");
        $("#peerIdSubmit").prop("disabled", !1).text("Connect");
        showAlert("Failed to join connection. Please try again.");
      }
    } else {
      console.log(`❌ No offer SDP found yet for peerId: ${peerId} (poll #${pollCount})`);
    }
  }, 3000);

  console.log(`⏰ Started polling for offers (timeout: ${CONNECTION_TIMEOUT / 1000}s, interval: 3s)`);
}

function updateConnectionStatus(message, percent, isFinal = !1) {
  $("#connectionStatusPanel").removeClass("d-none");
  $("#connectionStatusText").text(message);
  $("#connectionProgressBar").css("width", percent + "%");

  if (isFinal) {
    $("#connectionProgressBar").removeClass("custom-bg").addClass("bg-success");
    $("#spin-border").addClass("text-success");
  }
}

function showAlert(message, isError = !0) {
  const alertType = isError ? "alert-danger" : "alert-success";
  const alert = $(`
      <div class="alert custom-alert ${alertType} alert-dismissible fade show fixed-top d-flex align-items-center rounded-pill" role="alert" style="top: 10px; left: 50%; transform: translateX(-50%); z-index: 2000;">
        <span class="${
          isError ? "text-danger" : "text-success"
        }">${message}</span>
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      </div>
    `);

  $("body").append(alert);

  setTimeout(function () {
    alert.fadeOut(1000, function () {
      $(this).remove();
    });
  }, 4000);
}

function truncateName(name, len = 10) {
  name = name.trim();
  return name.length > len ? name.slice(0, len - 3) + "..." : name;
}

function togglePlayPause(containerId) {
  const player = window[`player_${containerId}`];
  const icon = document.getElementById(`icon-${containerId}`);

  if (!player) return;

  player.playPause();

  if (player.isPlaying()) {
    icon.classList.remove("fa-play");
    icon.classList.add("fa-pause");
  } else {
    icon.classList.remove("fa-pause");
    icon.classList.add("fa-play");
  }
}

function checkRelayFileLimit(fileSize) {
  if (isUsingRelay && fileSize > 50 * 1024 * 1024) {
    showAlert("TURN relay active — file transfers limited to 50 MB.", !0);
    return !1;
  }
  return !0;
}

function processNextFileInQueue() {
  if (pendingSendBatch.length > 0) {
    var item = pendingSendBatch.shift();
    const transfer = activeTransfers.get(item.messageId);
    const fileSize = transfer?.fileSize || item.file.size;

    if (!checkRelayFileLimit(fileSize)) {
      isSendingFile = !1;
      if (transfer) activeTransfers.delete(item.messageId);
      processNextFileInQueue();
      return;
    }

    isSendingFile = !0;
    $(`#${item.queueId}`).remove();

    const name = $("#chat-username").val() || "Anonymous";
    const fileUrl = URL.createObjectURL(item.file);
    displayMessage(
      name,
      item.file.name,
      !0,
      "file",
      fileUrl,
      item.messageId,
      "sent",
      transfer?.fileType || item.file.type || "application/octet-stream",
      transfer?.fileSize || item.file.size
    );
    showProgressBar(item.messageId, !0);

    setTimeout(() => { sendFileChunks(item.messageId); }, 100);
    return;
  }

  if (mediaSendQueue.length === 0) {
    isSendingFile = !1;
    return;
  }

  const queuedItem = mediaSendQueue.shift();
  const file = queuedItem.file;
  const queueId = queuedItem.queueId;

  if (!checkRelayFileLimit(file.size)) {
    isSendingFile = !1;
    processNextFileInQueue();
    return;
  }

  isSendingFile = !0;

  if (queueId) {
    $(`#${queueId}`).remove();
  }

  const name = $("#chat-username").val() || "Anonymous";
  const messageId = Date.now().toString();
  const useSingleChannel = file.size < 1024 * 1024;
  currentChunk = 0;
  totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const chunkParts = [];
  const numChannels = mediaChannels.length;
  const partSize = Math.ceil(file.size / numChannels);

  for (let i = 0; i < numChannels; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, file.size);
    chunkParts[i] = [];

    for (let offset = start; offset < end; offset += CHUNK_SIZE) {
      const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, end));
      chunkParts[i].push(slice);
    }
  }

  const transferIndex = nextTransferIndex++;
  activeTransfers.set(messageId, {
    file,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/octet-stream",
    totalChunks: chunkParts.flat().length,
    chunkParts,
    useSingleChannel,
    transferIndex,
  });

  const metadata = {
    type: "file",
    name,
    messageId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/octet-stream",
    useSingleChannel,
    transferIndex,
  };

  try {
    dataChannel.send(JSON.stringify(metadata));
    const fileUrl = URL.createObjectURL(file);
    displayMessage(name, file.name, !0, "file", fileUrl, messageId, "sent", metadata.fileType, metadata.fileSize);
    showProgressBar(messageId, !0);

    setTimeout(() => {
      sendFileChunks(messageId);
    }, 100);
  } catch (error) {
    console.error("Error sending file:", error);
    hideProgressBar(messageId);
    activeTransfers.delete(messageId);
    showAlert("Failed to send file. Please try again.");
    isSendingFile = !1;
    processNextFileInQueue();
  }
}

function updateNavbarForChat() {
  $("#headerActionsHome").addClass("d-none");
  $("#headerActionsChat").removeClass("d-none");
}

function updateNavbarForHome() {
  $("#headerActionsHome").removeClass("d-none");
  $("#headerActionsChat").addClass("d-none");
}

function setSecureState(enabled, fromSync) {
  if (fromSync && !isSecureSyncEnabled()) return;
  secureEnabled = enabled;
  applySecureSyncTheme();
  const $track = $("#secureToggleTrack");
  const $icon = $("#secureToggleIcon");
  const $label = $("#secureLabel");
  const $btn = $("#secureToggleBtn");
  const $hint = $("#secureHint");
  const $body = $("body");
  const $indicator = $("#secureIndicator");

  if (enabled) {
    $track.addClass("secure-on");
    $btn.addClass("secure-on");
    $label.addClass("secure-on").text("ON");
    $icon.removeClass("fa-lock").addClass("fa-lock-open");
    $hint.removeClass("d-none");
    $body.addClass("secure-mode-active");
    $indicator.removeClass("d-none");

    document.querySelectorAll('[data-encrypted="true"]').forEach(function (el) {
      var dict = parseInt(el.getAttribute("data-dictionary"), 10);
      var shift = parseInt(el.getAttribute("data-shift"), 10);
      var msgEl = el.querySelector(".message");
      if (!msgEl) return;
      var rawText = msgEl.textContent;
      callDecode(dict, shift, rawText).then(function (decoded) {
        if (decoded !== null) {
          msgEl.innerHTML = formatTextMsg(decoded);
        }
        el.removeAttribute("data-encrypted");
        el.removeAttribute("data-dictionary");
        el.removeAttribute("data-shift");
      });
    });
  } else {
    $track.removeClass("secure-on");
    $btn.removeClass("secure-on");
    $label.removeClass("secure-on").text("OFF");
    $icon.removeClass("fa-lock-open").addClass("fa-lock");
    $hint.addClass("d-none");
    $body.removeClass("secure-mode-active");
    $indicator.addClass("d-none");
  }
}

function sendSecureState(enabled) {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify({ type: "secure_state", enabled }));
  }
}

function handleIncomingChunk(arrayBuffer, messageId, channelLabel) {
  const transfer = mediaReceivingChunks[messageId];

  if (!transfer || !transfer.fileInfo) {
    console.warn(`⚠️ No fileInfo available for messageId: ${messageId}`);
    return;
  }

  if (!transfer.buffers) {
    transfer.buffers = [];
    transfer.receivedBytes = 0;
  }

  transfer.buffers.push(arrayBuffer);
  transfer.receivedBytes += arrayBuffer.byteLength;

  const receivedSize = transfer.receivedBytes;
  const totalSize = transfer.fileInfo.fileSize;
  updateProgressBar(messageId, (receivedSize / totalSize) * 100);

  if (receivedSize >= totalSize) {
    try {
      const blob = new Blob(transfer.buffers, {
        type: transfer.fileInfo.fileType || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);

      displayMessage(
        transfer.fileInfo.name,
        transfer.fileInfo.fileName,
        !1,
        "file",
        url,
        messageId,
        "delivered",
        transfer.fileInfo.fileType,
        transfer.fileInfo.fileSize
      );
    } catch (err) {
      console.error(`Error creating blob from chunks for ${messageId}:`, err);
      showAlert("Failed to reconstruct received file.");
    }

    hideProgressBar(messageId);
    delete mediaReceivingChunks[messageId];
  }
}

function showPeerOfflineModal() {
  if ($("#peerOfflineModal").length > 0) return;

  const modalHtml = `
    <div class="modal fade" id="peerOfflineModal" tabindex="-1" aria-labelledby="peerOfflineModalLabel" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content text-center">
          <div class="modal-header">
            <h5 class="modal-title w-100" id="peerOfflineModalLabel">Connection Lost</h5>
          </div>
          <div class="modal-body">
            <p>Your peer seems to be offline or has closed the chat.</p>
          </div>
          <div class="modal-footer justify-content-center">
            <button type="button" class="btn btn-primary" onclick="location.reload()">Reload</button>
          </div>
        </div>
      </div>
    </div>
  `;

  $("body").append(modalHtml);
  const modal = new bootstrap.Modal(document.getElementById("peerOfflineModal"));
  modal.show();
}

function formatTextMsg(text) {
  if (!text) return "";

  text = text.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  text = text.replace(/`([^`]+?)`/g, "<code>$1</code>");
  text = text.replace(/\*([^\*]+?)\*/g, "<strong>$1</strong>");
  text = text.replace(/_([^_]+?)_/g, "<em>$1</em>");
  text = text.replace(/~([^~]+?)~/g, "<s>$1</s>");
  text = text.replace(/(https?:\/\/[^\s]+)/g, `<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>`);

  return text.replace(/\n/g, "<br>");
}

function formatBytes(sizeInBytes) {
  const units = ["Bytes", "KB", "MB", "GB", "TB"];

  if (sizeInBytes === 0) return "0 Bytes";

  const i = Math.floor(Math.log(sizeInBytes) / Math.log(1024));
  const size = sizeInBytes / Math.pow(1024, i);

  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

function showImagePreview(imageSrc, filename, filesize) {
  const modal = document.getElementById('imagePreviewModal');
  const img = document.getElementById('imagePreviewImg');
  const filenameEl = document.getElementById('imagePreviewFilename');

  img.src = imageSrc;
  filenameEl.textContent = filename || 'Image';
  modal.setAttribute('data-current-src', imageSrc);
  modal.setAttribute('data-current-filename', filename || 'Image');
  modal.classList.remove('d-none');
  document.body.style.overflow = 'hidden';
}

function hideImagePreview() {
  const modal = document.getElementById('imagePreviewModal');
  modal.classList.add('d-none');
  document.body.style.overflow = '';
}

function downloadImage() {
  const modal = document.getElementById('imagePreviewModal');
  const imageSrc = modal.getAttribute('data-current-src');
  const filename = modal.getAttribute('data-current-filename');

  if (imageSrc) {
    const link = document.createElement('a');
    link.href = imageSrc;
    link.download = filename || 'image';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

$(document).ready(() => {
  $('#imagePreviewClose').click(hideImagePreview);
  $('#imagePreviewDownload').click(downloadImage);

  $('#imagePreviewModal').click(function (e) {
    if (e.target === this) {
      hideImagePreview();
    }
  });

  $(document).keydown(function (e) {
    if (e.key === 'Escape' && !$('#imagePreviewModal').hasClass('d-none')) {
      hideImagePreview();
    }
  });

  $(document).on('click', '.chat-message img', function (e) {
    e.preventDefault();
    const img = $(this);
    const src = img.attr('src');
    const alt = img.attr('alt') || 'Image';
    let fileSize = null;

    const messageContainer = img.closest('.chat-message');
    const fileSizeElements = messageContainer.find('.file-name, .text-end, .mb-3');

    fileSizeElements.each(function () {
      const text = $(this).text();

      if (text && (text.includes('KB') || text.includes('MB') || text.includes('GB') || text.includes('Bytes'))) {
        const match = text.match(/(\d+(?:\.\d+)?\s*(?:Bytes|KB|MB|GB|TB))/i);

        if (match) {
          fileSize = match[1];
          return !1;
        }
      }
    });

    showImagePreview(src, alt, fileSize);
  });
});
