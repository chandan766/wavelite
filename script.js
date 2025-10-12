// --- Config ---
// Cloudflare Pages Function endpoints for WebRTC signaling
const SIGNALING_BASE_URL = '/signaling';
const OFFER_URL = `${SIGNALING_BASE_URL}/offer`;
const ANSWER_URL = `${SIGNALING_BASE_URL}/answer`;
const CANDIDATE_URL = `${SIGNALING_BASE_URL}/candidate`;
const CLEANUP_URL = `${SIGNALING_BASE_URL}/cleanup`;

let localConnection, dataChannel;
let pollingInterval;
let isManuallyConnecting = false;
let peerId = null; // Global peerId variable
let mediaSendQueue = [];
let isSendingFile = false;
let pingIntervalId = null;
let mediaChannels = [];
let mediaReceivingChunks = {};
let lastPingReceivedTime = Date.now();
const CONNECTION_TIMEOUT = 120000; // 120 seconds timeout for connection
const CHUNK_TIMEOUT = 5000; // 10 seconds for chunk timeout
const MAX_RETRIES = 5; // Maximum retries for missing chunks
const NUM_MEDIA_CHANNELS = 3;
const PING_INTERVAL = 10000;

// File sending configuration
// const CHUNK_SIZE = 16384; // 16KB chunks for WebRTC data channel
const CHUNK_SIZE = 65536; // 64KB chunks for WebRTC data channel
const BUFFER_THRESHOLD = 262144; // 256KB buffer threshold to prevent overflow
let fileReader = new FileReader();
let currentFile = null;
let retryCounts = new Map(); // Track retries per messageId
let activeTransfers = new Map(); // Store file references for resending
const receivedTransfers = new Map(); // messageId → { fileInfo, buffers, receivedBytes }

$(document).ready(() => {
  let savedProfilePeerId = localStorage.getItem("peerIds") || "";
  let savedProfilePeerName = localStorage.getItem("peerName") || "";
  if (savedProfilePeerName) {
    $("#chat-username").val(savedProfilePeerName);
    $("#peer-id").val(savedProfilePeerId);
  }

  $("#peerIdSubmit").click(async function (e) {
    e.preventDefault(); // prevent form default submission
    isManuallyConnecting = true;
    var username = $("#chat-username").val().trim();
    peerId = $("#peer-id").val().trim(); // Set global peerId
    $("#chat-username").prop("disabled", true);
    $("#peer-id").prop("disabled", true);

    // Clear previous error messages
    $("#name-error").text("");
    $("#peer-error").text("");

    let hasError = false;

    if (!username) {
      username = "Anonymous";
    }

    if (!peerId) {
      peerId = "peer123";
    }

    if (hasError) {
      return;
    }

    // Proceed to connect
    $("#peerIdSubmit").prop("disabled", true).text("Connecting...");
    $("#joinPeer").prop("disabled", true).text("Join");
    $("#peerId").val(peerId);
    $("#peerBtnGroup").removeClass("d-flex").addClass("d-none");
    $("#connectionStatusPanel").removeClass("d-none");
    updateConnectionStatus("Connecting...", "5", false);
    startConnection(peerId);
  });

  // Handle file selection
  $("#media-input-group").change((event) => {
    const file = event.target.files[0];
    if (file) {
      currentFile = file;
    } else {
      currentFile = null;
    }
  });

  // Handle file sending on button click
  $("#btn-send-media").click(() => {
    if (!currentFile) {
      showAlert("No file is selected!");
      $("#media-input").click(); // Trigger file input if no file is selected
      return;
    }

    // Create a safe unique ID for the queued item
    const queueId = `queue-${Date.now()}`;
    const fileToSend = {
      file: currentFile,
      queueId: queueId,
    };

    // Show "Queued..." bar only if something is sending or already queued
    if (isSendingFile || mediaSendQueue.length > 0) {
      showQueuedProgress(queueId, currentFile.name);
    }

    currentFile = null;
    $("#chat-file").val("");
    // Push to queue
    mediaSendQueue.push(fileToSend);

    if (!isSendingFile) {
      processNextFileInQueue();
    }
  });

  $("#reloadBtn").click(function () {
    location.reload();
  });
  // Bind text send handler once
  $("#btn-send-text").click(() => {
    const name = $("#chat-username").val() || "Anonymous";
    const message = $("#chat-message").val();
    const messageId = Date.now().toString();
    if (message && dataChannel && dataChannel.readyState === "open") {
      console.log(
        "Sending text message, dataChannel state:",
        dataChannel.readyState
      );
      try {
        dataChannel.send(
          JSON.stringify({ type: "text", name, message, messageId })
        );
        displayMessage(name, message, true, "text", null, messageId, "sent");
        $("#chat-message").val("").focus();
      } catch (error) {
        console.error("Error sending text message:", error);
        showAlert("Failed to send message. Please try again.");
      }
    } else {
      console.warn(
        "Cannot send text, dataChannel state:",
        dataChannel ? dataChannel.readyState : "undefined"
      );
      showAlert(
        "Please wait until the connection is established before sending a message."
      );
    }
  });

  // Handle delete all button click
  $("#delete-all-btn").click(() => {
    fetch(CLEANUP_URL, {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: "" }),
    })
      .then((res) => res.json())
      .then((result) => {
        showAlert(`Deleted all SDP entries: ${result.message}`, false);
        // Wait 3 seconds before reloading
        setTimeout(() => {
          location.reload();
        }, 3000);
      })
      .catch((err) => showAlert(`Error deleting SDP entries: ${err}`));
  });

  // Handle Join button click
  $("#joinPeer").click(async function (e) {
    e.preventDefault();
    isManuallyConnecting = true;
    const username = $("#chat-username").val().trim();
    peerId = $("#peer-id").val().trim(); // Set global peerId
    $("#chat-username").prop("disabled", true);
    $("#peer-id").prop("disabled", true);
    // Clear previous error messages
    $("#name-error").text("");
    $("#peer-error").text("");

    let hasError = false;

    if (!username) {
      $("#name-error").text("Name is required");
      $("#chat-username").prop("disabled", false);
      $("#peer-id").prop("disabled", false);
      hasError = true;
    }

    if (!peerId) {
      $("#peer-error").text("Peer ID is required");
      $("#chat-username").prop("disabled", false);
      $("#peer-id").prop("disabled", false);
      hasError = true;
    }

    if (hasError) {
      return;
    }

    // Proceed to join
    $("#joinPeer").prop("disabled", true).text("Joining...");
    $("#peerIdSubmit").prop("disabled", true).text("Connect");
    $("#peerId").val(peerId);
    $("#peerBtnGroup").removeClass("d-flex").addClass("d-none");
    $("#connectionStatusPanel").removeClass("d-none");
    updateConnectionStatus("Joining...", "5", false);
    startJoinConnection(peerId);
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

    // Save to localStorage
    localStorage.setItem("peerIds", peerIdInput);
    localStorage.setItem("peerName", peerNameInput);
    showAlert(`Peer ID "${peerIdInput}" saved for notifications.`, false);

    // Ask for notification permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      alertBox
        .text(
          "Notification permission denied. Cannot able to notify the joining request"
        )
        .removeClass("d-none");
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
    loadStunSettings();
    loadApiKey();
  });

  // Save when any box is clicked (enforce minimum 2)
  $(document).on("change", ".stun-option", () => {
    const selected = $(".stun-option:checked")
      .map(function () {
        return this.value;
      })
      .get();

    if (selected.length < 1) {
      $("#stun-error").removeClass("d-none");
    } else {
      $("#stun-error").addClass("d-none");
      localStorage.setItem("selectedStunServers", JSON.stringify(selected));
      $("#stunSaveStatus").text(" ( Saved Successfully! )");
      setTimeout(() => {
        $("#stunSaveStatus").text("");
      }, 3000);
    }
  });

  let hasPrompted = false;
  window.autoCheckInterval = setInterval(async () => {
    if (isManuallyConnecting || hasPrompted) return;
    const savedPeers = localStorage.getItem("peerIds") || "peer123";
    const savedPeerName = localStorage.getItem("peerName") || "Anonymous";
    if (!savedPeers) return;
    const offer = await fetchSDP(savedPeers, "offer");
    if (offer) {
      if (
        Notification.permission === "granted" &&
        document.visibilityState !== "visible"
      ) {
        const notification = new Notification("Wavelite", {
          body: `Peer "${savedPeers}" is requesting to connect.`,
          icon: "/logo.png",
        });

        notification.onclick = function (event) {
          event.preventDefault(); // Prevent default behavior like focusing the tab

          // Bring window to front
          window.focus();

          // Trigger your modal
          $("#autoJoinMessage").text(
            `Peer "${savedPeers}" is requesting to connect. Do you want to join?`
          );
          const autoJoinModal = new bootstrap.Modal(
            document.getElementById("autoJoinModal")
          );
          autoJoinModal.show();

          // Bind Join button logic
          $("#autoJoinConfirmBtn")
            .off("click")
            .on("click", () => {
              autoJoinModal.hide();
              setTimeout(() => {
                isManuallyConnecting = true;
                $("#peer-id").val(savedPeers);
                $("#chat-username").val(savedPeerName);
                $("#joinPeer").click(); // Trigger join
              }, 300);
            });
        };
      } else if (Notification.permission !== "denied") {
        // Ask for permission only if not previously denied
        Notification.requestPermission().then((permission) => {
          if (
            permission === "granted" &&
            document.visibilityState !== "visible"
          ) {
            new Notification("Wavelite", {
              body: `Peer "${savedPeers}" is requesting to connect.`,
              icon: "/logo.png",
            });
          }
        });
      }
      // Show custom modal
      hasPrompted = true;
      if (document.visibilityState === "visible") {
        $("#autoJoinMessage").text(
          `Peer "${savedPeers}" is requesting to connect. Do you want to join?`
        );
        const autoJoinModal = new bootstrap.Modal(
          document.getElementById("autoJoinModal")
        );
        autoJoinModal.show();

        // Bind handler to Join button only once
        $("#autoJoinConfirmBtn")
          .off("click")
          .on("click", () => {
            autoJoinModal.hide();
            setTimeout(() => {
              isManuallyConnecting = true;
              $("#peer-id").val(savedPeers);
              $("#chat-username").val(savedPeerName);
              $("#joinPeer").click(); // Trigger join
            }, 300);
          });
      }
      return; // Stop checking after first found match
    }
  }, 3000); // every 3 seconds
});

async function startConnection(peerId) {
  console.log(`Starting connection for peerId: ${peerId}`);
  const offerEntry = await fetchSDP(peerId, "offer");
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
  updateConnectionStatus("Offer Creating...", "10", false);
  try {
    const offer = await localConnection.createOffer();
    await localConnection.setLocalDescription(offer);
    await waitForIceGathering(localConnection);
    console.log(`Submitting offer SDP for peerId: ${peerId}`);
    await submitSDP(
      peerId,
      "offer",
      JSON.stringify(localConnection.localDescription)
    );
    updateConnectionStatus("Waiting for peer...", "100", true);

    // Start polling for the answer with timeout
    let startTime = Date.now();
    pollingInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      if (elapsed > CONNECTION_TIMEOUT) {
        clearInterval(pollingInterval);
        $("#peerIdSubmit").prop("disabled", false).text("Connect");
        $("#joinPeer").prop("disabled", false).text("Join");
        showAlert("Connection timed out. Please try again or check peer ID.");
        $("#delete-all-btn").click();
        return;
      }
      const answerEntry = await fetchSDP(peerId, "answer");
      const percent = Math.min((elapsed / CONNECTION_TIMEOUT) * 100, 99);
      updateConnectionStatus("Waiting for peer...", percent, true);
      if (answerEntry) {
        console.log(`Answer SDP found for peerId: ${peerId}`);
        clearInterval(pollingInterval);
        try {
          const sdp = JSON.parse(answerEntry.sdp);
          await localConnection.setRemoteDescription(
            new RTCSessionDescription(sdp)
          );
          updateConnectionStatus("Connected Successfully!", "100", true);
          console.log("✅ Remote description (answer) set successfully");
        } catch (error) {
          console.error("❌ Failed to set remote description (answer):", error);
        }
      }
    }, 4000); // Polling interval 4 seconds
  } catch (error) {
    console.error("Error setting up offerer:", error);
    $("#peerIdSubmit").prop("disabled", false).text("Connect");
    $("#joinPeer").prop("disabled", false).text("Join");
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
    // Log and handle setRemoteDescription separately
    console.log("Parsing and setting remote offer...");
    const offerSDP = JSON.parse(offerEntry.sdp);
    await localConnection.setRemoteDescription(
      new RTCSessionDescription(offerSDP)
    );
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
    await submitSDP(
      offerEntry.peerId,
      "answer",
      JSON.stringify(localConnection.localDescription)
    );
  } catch (error) {
    console.error("❌ Error setting up answerer:", error);
    $("#peerIdSubmit").prop("disabled", false).text("Connect");
    $("#joinPeer").prop("disabled", false).text("Join");
    showAlert("Failed to establish connection. Please try again.");
  }
}

function createPeerConnection() {
  const savedStuns = JSON.parse(
    localStorage.getItem("selectedStunServers") || "[]"
  );
  const stunServers =
    savedStuns.length >= 1 ? savedStuns : ["stun:global.stun.twilio.com:3478"];

  const pc = new RTCPeerConnection({
    iceServers: stunServers.map((url) => ({ urls: url })),
    iceCandidatePoolSize: 0,
  });

  pc.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", pc.iceConnectionState);
    const $status = $("#status");
    if (["connected", "completed"].includes(pc.iceConnectionState)) {
      $status.text("Online");
    } else if (
      ["disconnected", "failed", "closed"].includes(pc.iceConnectionState)
    ) {
      $status.text("Offline");
    }
  };
  return pc;
}

function waitForIceGathering(pc) {
  updateConnectionStatus("ICE Gathering...", "80", false);
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
  updateConnectionStatus("Submitting Offer...", "90", false);
  
  const endpoint = role === 'offer' ? OFFER_URL : ANSWER_URL;
  
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId, sdp }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    console.log(`Submitted ${role} SDP for peerId: ${peerId}`, result);
    updateConnectionStatus("Offer Submitted", "99", false);
  } catch (error) {
    console.error(`Error submitting ${role} SDP:`, error);
    throw error;
  }
}

async function fetchSDP(peerId, role) {
  try {
    const endpoint = role === 'offer' ? OFFER_URL : ANSWER_URL;
    const url = `${endpoint}?peerId=${encodeURIComponent(peerId)}`;
    
    const response = await fetch(url, {
      method: "GET",
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    
    if (result.found) {
      console.log(`Found ${role} SDP for peerId: ${peerId}`);
      return { peerId: result.peerId, role: role, sdp: result.sdp };
    } else {
      console.log(`No ${role} SDP found for peerId: ${peerId}`);
      return null;
    }
  } catch (e) {
    console.error(`Failed to fetch ${role} SDP for peerId: ${peerId}:`, e);
    return null;
  }
}

function setupDataChannel() {
  if (!peerId) {
    console.error("peerId is undefined in setupDataChannel");
    return;
  }

  dataChannel.onopen = () => {
    console.log("Data channel opened for peerId:", peerId);
    deletePeerFromSheet(peerId);
    // Start periodic ping to peer
    pingIntervalId = setInterval(() => {
      if (dataChannel.readyState === "open") {
        dataChannel.send(
          JSON.stringify({ type: "ping", timestamp: Date.now() })
        );
      }
    }, PING_INTERVAL);

    dataChannel.send(
      JSON.stringify({
        type: "username",
        name: truncateName($("#chat-username").val() || "Anonymous"),
      })
    );
    transitionToChat();
  };

  dataChannel.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      const view = new Uint32Array(e.data, 0, 3);
      const [majorIndex, chunkIndex, totalChunks] = view;
      // ✅ Safely identify single-channel transfer
      let messageId = null;
      for (const [id, transfer] of receivedTransfers.entries()) {
        if (transfer.fileInfo.useSingleChannel) {
          messageId = id;
          break;
        }
      }
      if (!messageId) {
        console.warn(
          "No active single-channel transfer found for incoming chunk."
        );
        return;
      }
      const transfer = receivedTransfers.get(messageId);
      if (!transfer) {
        console.warn("Received chunk but no file info available yet.");
        return;
      }

      const chunkData = e.data.slice(12); // Remove header (3 Uint32 = 12 bytes)
      transfer.buffers.push(chunkData);
      transfer.receivedBytes += chunkData.byteLength;
      transfer.expectedChunk++;

      updateProgressBar(
        messageId,
        (transfer.receivedBytes / transfer.fileInfo.fileSize) * 100
      );

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
            false,
            "file",
            url,
            messageId,
            "delivered",
            transfer.fileInfo.fileType,
            transfer.fileInfo.fileSize
          );
        } catch (err) {
          console.error(
            `Error reconstructing file ${transfer.fileInfo.fileName}:`,
            err
          );
          showAlert("Failed to reconstruct received file.");
        }
        hideProgressBar(messageId);
        receivedTransfers.delete(messageId);
        retryCounts.delete(messageId);
      } else {
        clearTimeout(transfer.timeoutId);
        transfer.timeoutId = setTimeout(() => {
          const retryCount = retryCounts.get(messageId) || 0;
          if (retryCount < MAX_RETRIES) {
            console.warn(
              `Resend request: ${messageId} [${majorIndex}-${transfer.expectedChunk}]`
            );
            retryCounts.set(messageId, retryCount + 1);
            dataChannel.send(
              JSON.stringify({
                type: "resend_request",
                messageId,
                majorIndex,
                chunkIndex: transfer.expectedChunk,
              })
            );
          } else {
            showAlert(
              `Failed to receive all chunks for ${transfer.fileInfo.fileName}.`
            );
            hideProgressBar(messageId);
            receivedTransfers.delete(messageId);
            retryCounts.delete(messageId);
          }
        }, CHUNK_TIMEOUT);
      }
    } else {
      const msg = JSON.parse(e.data);

      if (msg.type === "text") {
        displayMessage(
          msg.name,
          msg.message,
          false,
          "text",
          null,
          msg.messageId,
          "delivered"
        );
      } else if (msg.type === "location") {
        displayMessage(
          msg.name || "Peer",
          msg,
          false,
          "location",
          null,
          msg.messageId,
          "delivered"
        );
      } else if (msg.type === "file") {
        receivedTransfers.set(msg.messageId, {
          fileInfo: {
            name: msg.name,
            messageId: msg.messageId,
            fileName: msg.fileName,
            fileSize: msg.fileSize,
            fileType: msg.fileType,
            useSingleChannel: msg.useSingleChannel || false,
          },
          buffers: [],
          receivedBytes: 0,
          expectedChunk: 0,
          lastChunkTime: Date.now(),
          timeoutId: null,
        });

        if (!msg.useSingleChannel) {
          mediaReceivingChunks[msg.messageId] = {
            fileInfo: {
              name: msg.name,
              fileName: msg.fileName,
              fileSize: msg.fileSize,
              fileType: msg.fileType,
            },
            parts: new Array(NUM_MEDIA_CHANNELS), // Pre-allocate for chunk tracking
            bytesReceived: 0,
            expectedSize: msg.fileSize,
            completed: false,
          };
        }

        showProgressBar(msg.messageId, false);
        console.log(`Received file metadata for ${msg.fileName}`);
      } else if (msg.type === "resend_request") {
        console.log(
          `🔁 Resend request for ${msg.messageId} [${msg.majorIndex}-${msg.chunkIndex}]`
        );
        resendFileChunk(msg.messageId, msg.majorIndex, msg.chunkIndex);
      } else if (msg.type === "username") {
        console.log("Received peer username:", msg.name);
        $("#headerBtnName").text(msg.name).addClass("text-capitalize");
      } else if (msg.type === "ping") {
        console.log(
          `📡 Ping received from peer at ${new Date(
            msg.timestamp
          ).toLocaleTimeString()}`
        );
        $("#status").text("Online");
        lastPingReceivedTime = Date.now();
      }
    }
  };

  dataChannel.onerror = (error) => {
    console.error("Data channel error:", error);
    for (const [messageId, transfer] of receivedTransfers.entries()) {
      hideProgressBar(messageId);
      showAlert(
        `Transfer error for ${transfer.fileInfo.fileName}. Please try again.`
      );
      clearTimeout(transfer.timeoutId);
      retryCounts.delete(messageId);
    }
    receivedTransfers.clear();
  };
}

function setupMediaDataChannel(channel, index) {
  channel.onmessage = (e) => {
    const data = new Uint8Array(e.data);
    const metadata = new Uint32Array(data.slice(0, 12).buffer); // 3 * 4 bytes = 12
    const majorIndex = metadata[0];
    const chunkIndex = metadata[1];
    const totalChunks = metadata[2];
    const payload = data.slice(12);

    // 🚫 Ignore if not meant for multi-channel (i.e., single-channel file or uninitialized)
    const activeTransferEntry = Object.entries(mediaReceivingChunks).find(
      ([_, transfer]) => !transfer.completed && transfer.parts.length === 3
    );
    if (!activeTransferEntry) {
      console.warn(
        "Received chunk but no file info available yet or this is a single-channel transfer."
      );
      return;
    }

    const [messageId, transfer] = activeTransferEntry;

    if (!transfer.parts[majorIndex]) {
      transfer.parts[majorIndex] = new Array(totalChunks).fill(null);
    }

    if (!transfer.parts[majorIndex][chunkIndex]) {
      transfer.parts[majorIndex][chunkIndex] = payload;
      transfer.bytesReceived += payload.byteLength;
    }

    if (!transfer.lastReceivedTime) transfer.lastReceivedTime = {};
    transfer.lastReceivedTime[`${majorIndex}-${chunkIndex}`] = Date.now();

    // Resend checker for missing chunks
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
                console.warn(
                  `⏳ Missing chunk detected: [${m}-${c}] for messageId ${messageId}`
                );
                dataChannel.send(
                  JSON.stringify({
                    type: "resend_request",
                    messageId,
                    majorIndex: m,
                    chunkIndex: c,
                  })
                );
                return; // Only one resend per interval
              }
            }
          }
        }
      }, CHUNK_TIMEOUT);
    }

    updateProgressBar(
      messageId,
      (transfer.bytesReceived / transfer.expectedSize) * 100
    );

    const isComplete =
      transfer.parts.length === 3 &&
      transfer.parts.every(
        (part) =>
          Array.isArray(part) &&
          part.length === totalChunks &&
          part.every((chunk) => chunk !== null && chunk !== undefined)
      );

    if (!isComplete) {
      console.warn(
        `❗ File assembly attempted before all chunks arrived. Parts:`,
        transfer.parts
      );
      return;
    }

    clearInterval(transfer.resendIntervalId);
    delete transfer.resendIntervalId;
    transfer.completed = true;

    const blobParts = transfer.parts.flat();
    const finalBlob = new Blob(blobParts, { type: transfer.fileInfo.fileType });
    const url = URL.createObjectURL(finalBlob);

    displayMessage(
      transfer.fileInfo.name,
      transfer.fileInfo.fileName,
      false,
      "file",
      url,
      messageId,
      "delivered",
      transfer.fileInfo.fileType,
      transfer.fileInfo.fileSize
    );

    hideProgressBar(messageId);
    delete mediaReceivingChunks[messageId];
  };

  channel.onerror = (err) => {
    console.error("Media channel error (index " + index + "):", err);
    // showAlert("Error on media channel " + index);
    $("#status").text("Offline");
    showPeerOfflineModal();
  };

  channel.onopen = () => {
    console.log("Media data channel " + index + " opened");
  };
}

function sendFileChunks(messageId, onComplete = () => {}) {
  const transfer = activeTransfers.get(messageId);
  if (!transfer) return;

  // ✅ If file is < 1MB, use a single data channel
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
        console.log(
          "✅ File sending complete (single channel) for messageId:",
          messageId
        );
        hideProgressBar(messageId);
        $("#chat-file").val("");
        $("#btn-toggle-back").click();
        currentFile = null;
        activeTransfers.delete(messageId);
        retryCounts.delete(messageId);
        onComplete();
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
          const meta = new Uint32Array([0, currentChunk, totalChunks]);
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
          onComplete();
        }
      };

      reader.onerror = () => {
        console.error("❌ FileReader error during send");
        hideProgressBar(messageId);
        showAlert("Failed to read file chunk.");
        onComplete();
      };

      reader.readAsArrayBuffer(slice);
    };

    sendChunk();
    return; // ✅ Exit here if using single channel
  }

  // 🔁 Multi-channel logic for files >= 1MB
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
          const meta = new Uint32Array([
            majorIndex,
            subIndex,
            partChunks.length,
          ]);
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
          onComplete();
        }
      };

      reader.onerror = () => {
        console.error("❌ FileReader error");
        hideProgressBar(messageId);
        showAlert("Failed to read chunk");
        onComplete();
      };

      reader.readAsArrayBuffer(partChunks[subIndex]);
    };

    sendNext();
  });

  const checkComplete = setInterval(() => {
    if (totalSentChunks >= totalSubChunks) {
      clearInterval(checkComplete);
      console.log("✅ File sending complete for messageId:", messageId);
      hideProgressBar(messageId);
      $("#chat-file").val("");
      $("#btn-toggle-back").click();
      currentFile = null;
      activeTransfers.delete(messageId);
      retryCounts.delete(messageId);
      onComplete();
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
    console.warn(
      `Chunk not found for resend: major ${majorIndex}, index ${chunkIndex}`
    );
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
      const meta = new Uint32Array([majorIndex, chunkIndex, partChunks.length]);
      const data = new Uint8Array(reader.result);
      const combined = new Uint8Array(meta.byteLength + data.byteLength);
      combined.set(new Uint8Array(meta.buffer), 0);
      combined.set(data, meta.byteLength);

      channel.send(combined.buffer);
      console.log(
        `✅ Resent chunk [${majorIndex}-${chunkIndex}] for messageId: ${messageId}`
      );
    } catch (error) {
      console.error(`❌ Resend failed:`, error);
    }
  };

  reader.onerror = () => {
    console.error(
      `❌ FileReader error during resend for [${majorIndex}-${chunkIndex}]`
    );
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
    $("#peerIdSubmit").prop("disabled", false).text("Disconnect");
    console.log("Transitioned to chat UI");
  }
}

function displayMessage(
  name,
  content,
  isSelf,
  type,
  file,
  messageId,
  status,
  fileType = null,
  fileSize = null
) {
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
  }
  else if (type === "location") {
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
          waveColor: "#ccc",
          progressColor: "#0d6efd",
          height: 80,
          responsive: true,
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
      } else if (
        fileType === "application/vnd.ms-excel" ||
        fileType ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ) {
        fileIconClass = "fa-file-excel text-success";
      } else if (
        fileType === "application/vnd.ms-powerpoint" ||
        fileType ===
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      ) {
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
    $("#chat-display").append(`
      <div class="chat-message ${alignClass} px-3">
        <div class="message py-1" style="font-size:12px;font-weight:450;">${messageContent}</div>
        <div class="message-meta d-flex justify-content-end border-top border-secondary mt-2">
          <span class="timestamp text-end" style="font-size:10px;">${
            isSelf ? "" : `<span class="name" style="font-size:12px;"></span>`
          } ${timestamp} ${statusIcon}</span>
        </div>
      </div>
    `);
    $("#chat-display").scrollTop($("#chat-display")[0].scrollHeight);
    console.log(
      `Displayed message for ${type}: ${content}, fileType: ${
        fileType || "none"
      }`
    );
  } catch (error) {
    console.error(`Error displaying message for ${content}:`, error);
    showAlert("Failed to display message in UI. Please refresh the page.");
  }
}
function deletePeerFromSheet(peerId) {
  if (!peerId) {
    console.error("peerId is undefined in deletePeerFromSheet");
    return;
  }
  fetch(CLEANUP_URL, {
    method: "POST",
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId }),
  })
    .then((res) => res.json())
    .then((result) => console.log("Deleted SDP for peerId:", peerId, result))
    .catch((err) => console.error("Delete error for peerId:", peerId, err));
}

async function startJoinConnection(peerId) {
  console.log(`Starting join connection for peerId: ${peerId}`);
  updateConnectionStatus("Waiting for offer...", "10", false);
  // Start polling for offer with timeout
  let startTime = Date.now();
  pollingInterval = setInterval(async () => {
    const elapsed = Date.now() - startTime;
    if (elapsed > CONNECTION_TIMEOUT) {
      clearInterval(pollingInterval);
      $("#joinPeer").prop("disabled", false).text("Join");
      $("#peerIdSubmit").prop("disabled", false).text("Connect");
      showAlert("No offer found. Please try again or check peer ID.");
      return;
    }
    const offerEntry = await fetchSDP(peerId, "offer");
    const percent = Math.min((elapsed / CONNECTION_TIMEOUT) * 100, 99);
    updateConnectionStatus("Waiting for offer...", percent, true);
    if (offerEntry) {
      console.log(
        `Offer SDP found for peerId: ${peerId}, proceeding as answerer`
      );
      clearInterval(pollingInterval);
      try {
        await setupAnswerer(offerEntry);
        updateConnectionStatus("Joined Successfully", "100", true);
      } catch (error) {
        console.error("Error during join connection:", error);
        $("#joinPeer").prop("disabled", false).text("Join");
        $("#peerIdSubmit").prop("disabled", false).text("Connect");
        showAlert("Failed to join connection. Please try again.");
      }
    } else {
      console.log(`No offer SDP found yet for peerId: ${peerId}`);
    }
  }, 3000); // Polling interval 3 seconds
}

// Initialize checkboxes from localStorage or default to 2
function loadStunSettings() {
  const defaultStuns = ["stun:global.stun.twilio.com:3478"];
  const savedStuns = JSON.parse(
    localStorage.getItem("selectedStunServers") || "[]"
  );

  const selected = savedStuns.length >= 1 ? savedStuns : defaultStuns;
  $(".stun-option").each(function () {
    $(this).prop("checked", selected.includes(this.value));
  });
}

function updateConnectionStatus(message, percent, isFinal = false) {
  $("#connectionStatusPanel").removeClass("d-none");
  $("#connectionStatusText").text(message);
  $("#connectionProgressBar").css("width", percent + "%");

  if (isFinal) {
    $("#connectionProgressBar").removeClass("custom-bg").addClass("bg-success");
    $("#spin-border").addClass("text-success");
  }
}

function showAlert(message, isError = true) {
  // Determine the alert type
  const alertType = isError ? "alert-danger" : "alert-success";

  // Create the alert element
  const alert = $(`
      <div class="alert custom-alert ${alertType} alert-dismissible fade show fixed-top d-flex align-items-center rounded-pill" role="alert" style="top: 10px; left: 50%; transform: translateX(-50%); z-index: 2000;">
        <span class="${
          isError ? "text-danger" : "text-success"
        }">${message}</span>
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      </div>
    `);

  // Append the alert to the body
  $("body").append(alert);

  // Auto fade out after 4 seconds
  setTimeout(function () {
    alert.fadeOut(1000, function () {
      $(this).remove(); // Remove the alert after fade out
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

  player.playPause(); // Toggle player state

  // Update icon
  if (player.isPlaying()) {
    icon.classList.remove("fa-play");
    icon.classList.add("fa-pause");
  } else {
    icon.classList.remove("fa-pause");
    icon.classList.add("fa-play");
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
  const name = $("#chat-username").val() || "Anonymous";
  const messageId = Date.now().toString();
  const useSingleChannel = file.size < 1024 * 1024; // Less than 1MB
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

  activeTransfers.set(messageId, {
    file,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/octet-stream",
    totalChunks: chunkParts.flat().length,
    chunkParts,
    useSingleChannel,
  });

  const metadata = {
    type: "file",
    name,
    messageId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/octet-stream",
    useSingleChannel,
  };

  try {
    dataChannel.send(JSON.stringify(metadata));
    const fileUrl = URL.createObjectURL(file);
    displayMessage(
      name,
      file.name,
      true,
      "file",
      fileUrl,
      messageId,
      "sent",
      metadata.fileType,
      metadata.fileSize
    );
    showProgressBar(messageId, true);
    // Delay to ensure metadata is processed before data chunks arrive
    setTimeout(() => {
      sendFileChunks(messageId, () => {
        isSendingFile = false;
        processNextFileInQueue();
      });
    }, 100); // 100ms delay is usually enough
  } catch (error) {
    console.error("Error sending file:", error);
    hideProgressBar(messageId);
    activeTransfers.delete(messageId);
    showAlert("Failed to send file. Please try again.");
    isSendingFile = false;
    processNextFileInQueue();
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
        false,
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
  if ($("#peerOfflineModal").length > 0) return; // Prevent duplicates

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
  const modal = new bootstrap.Modal(
    document.getElementById("peerOfflineModal")
  );
  modal.show();
}

function formatTextMsg(text) {
  if (!text) return "";

  // Escape all HTML
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Lightweight markup
  text = text.replace(/`([^`]+?)`/g, "<code>$1</code>");
  text = text.replace(/\*([^\*]+?)\*/g, "<strong>$1</strong>");
  text = text.replace(/_([^_]+?)_/g, "<em>$1</em>");
  text = text.replace(/~([^~]+?)~/g, "<s>$1</s>");

  // Auto-link URLs
  text = text.replace(
    /(https?:\/\/[^\s]+)/g,
    `<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>`
  );

  // Line breaks
  return text.replace(/\n/g, "<br>");
}

function formatBytes(sizeInBytes) {
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  if (sizeInBytes === 0) return "0 Bytes";

  const i = Math.floor(Math.log(sizeInBytes) / Math.log(1024));
  const size = sizeInBytes / Math.pow(1024, i);

  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

// Image Preview Modal Functions
function showImagePreview(imageSrc, filename, filesize) {
  const modal = document.getElementById('imagePreviewModal');
  const img = document.getElementById('imagePreviewImg');
  const filenameEl = document.getElementById('imagePreviewFilename');
  
  img.src = imageSrc;
  filenameEl.textContent = filename || 'Image';
  
  // Store the current image source for download
  modal.setAttribute('data-current-src', imageSrc);
  modal.setAttribute('data-current-filename', filename || 'Image');
  
  modal.classList.remove('d-none');
  document.body.style.overflow = 'hidden'; // Prevent background scrolling
}

function hideImagePreview() {
  const modal = document.getElementById('imagePreviewModal');
  modal.classList.add('d-none');
  document.body.style.overflow = ''; // Restore scrolling
}

// Download image function
function downloadImage() {
  const modal = document.getElementById('imagePreviewModal');
  const imageSrc = modal.getAttribute('data-current-src');
  const filename = modal.getAttribute('data-current-filename');
  
  if (imageSrc) {
    // Create a temporary link element
    const link = document.createElement('a');
    link.href = imageSrc;
    link.download = filename || 'image';
    
    // Trigger the download
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

// Add event listeners for image preview
$(document).ready(() => {
  // Close button click
  $('#imagePreviewClose').click(hideImagePreview);
  
  // Download button click
  $('#imagePreviewDownload').click(downloadImage);
  
  // Click outside modal to close
  $('#imagePreviewModal').click(function(e) {
    if (e.target === this) {
      hideImagePreview();
    }
  });
  
  // ESC key to close
  $(document).keydown(function(e) {
    if (e.key === 'Escape' && !$('#imagePreviewModal').hasClass('d-none')) {
      hideImagePreview();
    }
  });
  
  // Handle image clicks in chat messages
  $(document).on('click', '.chat-message img', function(e) {
    e.preventDefault();
    const img = $(this);
    const src = img.attr('src');
    const alt = img.attr('alt') || 'Image';
    
    // Try to get file size from the message context
    let fileSize = null;
    const messageContainer = img.closest('.chat-message');
    
    // Look for file size in various possible locations
    const fileSizeElements = messageContainer.find('.file-name, .text-end, .mb-3');
    fileSizeElements.each(function() {
      const text = $(this).text();
      if (text && (text.includes('KB') || text.includes('MB') || text.includes('GB') || text.includes('Bytes'))) {
        // Extract file size from text like "1.2 MB • JPG"
        const match = text.match(/(\d+(?:\.\d+)?\s*(?:Bytes|KB|MB|GB|TB))/i);
        if (match) {
          fileSize = match[1];
          return false; // Break the loop
        }
      }
    });
    
    showImagePreview(src, alt, fileSize);
  });
});
