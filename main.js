 $(document).ready(function () {

      $('#stunServerCollapse').on('shown.bs.collapse', () => {
        $('#stunToggleIcon').removeClass('fa-chevron-down').addClass('fa-chevron-up');
      });

      $('#stunServerCollapse').on('hidden.bs.collapse', () => {
        $('#stunToggleIcon').removeClass('fa-chevron-up').addClass('fa-chevron-down');
      });

      // Toggle back to text input mode
      $('#btn-toggle-back').click(() => {
        $('#media-input-group').addClass('d-none');
        $('#text-input-group').removeClass('d-none');
        $('#chat-file').val('');
      });
      // Handle toggle
      $('#btn-toggle').on('click', () => {
        // Hide keyboard if open
        $('#chat-message').blur();

        // Toggle menu
        $('#attachment-menu').toggleClass('d-none');
      });

      // Auto hide when tapping outside (optional)
      $(document).on('click', (e) => {
        if (!$(e.target).closest('#attachment-menu, #btn-toggle').length) {
          $('#attachment-menu').addClass('d-none');
        }
      });

     $('.attachment-btn').on('click', function () {
        const type = $(this).data('type');
        const $input = $('#chat-file');

        // Reset
        $input.removeAttr('accept capture');

        switch (type) {
          case 'image':
            $input.attr('accept', 'image/*');
            showFileInput(type);
            break;

          case 'camera':
            $input.attr('accept', 'image/*').attr('capture', 'environment');
            showFileInput(type);
            break;

          case 'video':
            $input.attr('accept', 'video/*');
            showFileInput(type);
            break;

          case 'audio':
            $input.attr('accept', 'audio/*');
            showFileInput(type);
            break;

          case 'doc':
            $input.attr('accept', '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.odt');
            showFileInput(type);
            break;

          case 'file':
            showFileInput(type);
            break;

          case 'record-voice':
            startVoiceRecording();
            break;

          case 'record-video':
            startVideoRecording();
            break;

          case 'location':
            shareLocation();
            break;

          case 'link':
            const url = prompt('Enter a link to share:');
            if (url && url.startsWith('http')) sendLinkMessage(url);
            break;
        }

        $('#attachment-menu').addClass('d-none');
    });
    let mediaRecorder, recordedChunks = [], voiceTimerInterval, voiceSeconds = 0,videoTimerInterval, videoSeconds = 0;
    function showFileInput(type) {
      $('#chat-file').data('attachment-type', type); // Store type for use later
      $('#chat-file').click();
      $('#media-input-group').removeClass('d-none');
      $('#text-input-group').addClass('d-none');
    }

    function startVoiceRecording() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Media recording not supported on this browser.');
        return;
      }

      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
          mediaRecorder = new MediaRecorder(stream);
          recordedChunks = [];

          mediaRecorder.ondataavailable = e => {
            if (e.data.size) recordedChunks.push(e.data);
          };

          mediaRecorder.onstop = () => {
            clearInterval(voiceTimerInterval);
            $('#voiceRecordingTimer').text('00:00');
            voiceSeconds = 0;
            const blob = new Blob(recordedChunks, { type: 'audio/webm' });
            attachBlobToFileInput(blob, 'record-voice.webm');
          };

          mediaRecorder.start();

          // Show modal and start timer
          $('#voiceRecordingModal').modal('show');
          startVoiceTimer();

        })
        .catch(err => alert('Microphone access denied or not available'));
    }

    function startVoiceTimer() {
      voiceTimerInterval = setInterval(() => {
        voiceSeconds++;
        const mins = String(Math.floor(voiceSeconds / 60)).padStart(2, '0');
        const secs = String(voiceSeconds % 60).padStart(2, '0');
        $('#voiceRecordingTimer').text(`${mins}:${secs}`);
      }, 1000);
    }

    $('#stopVoiceRecordingBtn').on('click', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        $('#voiceRecordingModal').modal('hide');
      }
    });


    function startVideoRecording() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Media recording not supported on this browser.');
        return;
      }

      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
        mediaRecorder = new MediaRecorder(stream);
        recordedChunks = [];

        // Show modal and stream preview
        const videoEl = $('#videoPreview')[0];
        videoEl.srcObject = stream;

        $('#videoRecordingModal').modal('show');

        mediaRecorder.ondataavailable = e => {
          if (e.data.size) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          clearInterval(voiceTimerInterval);
          $('#videoRecordingTimer').text('00:00');
          voiceSeconds = 0;

          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          attachBlobToFileInput(blob, 'record-video.webm');

          // Stop webcam stream tracks
          stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        startVoiceTimer(); // Reuse voice timer for display
      }).catch(err => alert('Camera access denied'));
    }

    function startVideoTimer() {
      videoTimerInterval = setInterval(() => {
        videoSeconds++;
        const mins = String(Math.floor(videoSeconds / 60)).padStart(2, '0');
        const secs = String(videoSeconds % 60).padStart(2, '0');
        $('#videoRecordingTimer').text(`${mins}:${secs}`);
      }, 1000);
    }

    function resetVideoTimer() {
      clearInterval(videoTimerInterval);
      $('#videoRecordingTimer').text('00:00');
      videoSeconds = 0;
    }

    $('#stopVideoRecordingBtn').on('click', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        $('#videoRecordingModal').modal('hide');
      }
    });

    let useFrontCamera = true;
    let currentStream;

    function startVideoRecording() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Media recording not supported on this browser.');
        return;
      }

      const constraints = {
        video: { facingMode: useFrontCamera ? 'user' : 'environment' },
        audio: true
      };

      navigator.mediaDevices.getUserMedia(constraints).then(stream => {
        currentStream = stream;
        mediaRecorder = new MediaRecorder(stream);
        recordedChunks = [];

        const videoEl = $('#videoPreview')[0];
        videoEl.srcObject = stream;

        $('#videoRecordingModal').modal('show');

        mediaRecorder.ondataavailable = e => {
          if (e.data.size) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          resetVideoTimer();

          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          attachBlobToFileInput(blob, 'record-video.webm');

          // Stop the camera
          currentStream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        startVideoTimer();
      }).catch(err => alert('Camera access denied'));
    }

    $('#stopVideoRecordingBtn').on('click', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        $('#videoRecordingModal').modal('hide');
      }
    });

    $('#switchCameraBtn').on('click', () => {
      useFrontCamera = !useFrontCamera;
      // Stop existing stream before restarting
      if (currentStream) currentStream.getTracks().forEach(track => track.stop());
      startVideoRecording(); // Restart with new camera
    });


    function shareLocation() {
      if (!navigator.geolocation) {
        alert('Geolocation not supported');
        return;
      }

      navigator.permissions.query({ name: 'geolocation' }).then(result => {
        if (result.state === 'denied') {
          alert('Location access denied. Please allow it in browser settings.');
          return;
        }

        navigator.geolocation.getCurrentPosition(pos => {
          const { latitude, longitude } = pos.coords;
          const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
          sendLocationMessage(mapsUrl); 
        }, err => {
          alert('Failed to get location');
        });
      });
    }


    function sendLinkMessage(url) {
      // Send as simple text or with a preview
      var url_ = `<a href="${url}" target="_blank">${truncateName(url,20)}</a>`;
      sendTextMessage(url);
    }

    function sendLocationMessage(link) {
      // Use your sendTextMessage function or show map preview
      sendTextMessage(`📍 <a href="${link}" target="_blank">${truncateName(link,20)}</a>`);
    }

    function attachBlobToFileInput(blob, filename) {
      const file = new File([blob], filename, { type: blob.type });

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const $fileInput = $('#chat-file')[0];
      $fileInput.files = dataTransfer.files;

      $($fileInput).trigger('change');
      // Show media input group
      $('#media-input-group').removeClass('d-none');
      $('#text-input-group').addClass('d-none');
    }

    function sendTextMessage(msg){
      $('#chat-message').val(msg);
    }

  });
  