# Wave Lite

Wave Lite is a lightweight, peer-to-peer chat application built using WebRTC for real-time communication. It allows users to exchange text messages and files (images, audio, video, and other formats) directly between browsers without a central server. The application features a clean, WhatsApp-inspired UI and supports progress bars for file uploads and downloads.

**Created by Chandan Maurya**

## Features
- **Peer-to-Peer Communication**: Uses WebRTC Data Channels for direct text and file transfers.
- **Text Messaging**: Send and receive text messages in real-time.
- **File Sharing**: Share images, audio, video, and other files with progress bars showing upload/download status.
- **Media Rendering**: Displays images inline, provides controls for audio/video, and includes download links for all files.
- **Responsive UI**: WhatsApp-like chat interface with sender/receiver message alignment and timestamps.
- **Error Handling**: Robust handling for connection timeouts, file transfer failures, and missing chunks with retry mechanisms.
- **No Server Storage**: Uses Cloudflare Worker for temporary SDP exchange during connection setup, with automatic cleanup.

## Prerequisites
- A modern web browser (e.g., Chrome, Firefox, Edge) with WebRTC support.
- Internet access for initial connection setup via Cloudflare Worker.
- Basic knowledge of HTML, CSS, and JavaScript for local hosting.
- Cloudflare account for deploying the signaling worker (optional for local development).

## Project Structure
```
wave-lite/
├── index.html      # Main HTML file for the application
├── script.js       # JavaScript logic for WebRTC, messaging, and file transfers
├── main.js         # UI interactions and event handlers
├── style.css       # CSS for styling the UI
├── assets/         # Images and other static assets
├── about.html      # About page
├── faq.html        # FAQ page
├── feedback.html   # Feedback form
├── usermanual.html # User manual
├── workers/        # Cloudflare Worker for signaling
│   ├── signaling.js # Signaling worker implementation
│   └── wrangler.toml # Worker configuration
└── README.md       # Project documentation
```

## Cloudflare Worker Setup

The signaling system now uses a Cloudflare Worker instead of Google Forms. To deploy the worker:

1. **Install Wrangler CLI**:
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare**:
   ```bash
   wrangler login
   ```

3. **Deploy the Worker**:
   ```bash
   cd workers
   wrangler deploy
   ```

4. **Update the Signaling URL**:
   - After deployment, update the `SIGNALING_URL` in `script.js` with your worker URL
   - The URL will be something like: `https://wavelite-signaling.your-subdomain.workers.dev`

For local development, you can run the worker locally:
```bash
cd workers
wrangler dev
```

## How to Use
1. **Access the Application**:
   - Open `https://wavelite.pages.dev/`  browser windows/tabs or on two different devices.

2. **Connect to a Peer**:
   - In the first browser, enter your name and a unique Peer ID (e.g., `peer123`), then click "Connect". This acts as the offerer.
   - In the second browser, enter a different name and the same Peer ID (`peer123`), then click "Connect". This acts as the answerer.
   - Wait for the connection to establish (up to 30 seconds). The UI will transition to the chat interface upon successful connection.

3. **Send Messages**:
   - Type a message in the text input and click the send button (paper plane icon).
   - Messages appear with timestamps, aligned to the right (self) or left (other), and show a double-check icon for sent status.

4. **Share Files**:
   - Click the attachment icon to select a file (image, audio, video, or other).
   - Click the send button to start the transfer. A progress bar with the file name and percentage appears for both sender and receiver.
   - Once complete, images are displayed inline, audio/video files get playable controls, and other files show a download link with the file name and icon.

5. **Disconnect**:
   - Click "Disconnect" to close the connection and return to the login screen. The Peer ID is cleared from the SDP exchange server.

## Technical Details
- **WebRTC**: Uses RTCPeerConnection and RTCDataChannel for peer-to-peer communication.
- **SDP Exchange**: Temporarily stores Session Description Protocol (SDP) data in a Cloudflare Worker, with automatic deletion after connection.
- **File Transfer**:
  - Files are split into 16KB chunks for reliable transfer over WebRTC Data Channels.
  - Includes buffer overflow handling, chunk resend requests, and a 15-second timeout with up to 3 retries for missing chunks.
- **UI**: Built with Bootstrap for responsive design, jQuery for DOM manipulation, and Font Awesome for icons.
- **Progress Bar**: Displays file name and percentage during uploads/downloads, styled with Bootstrap's progress bar component.

## Limitations
- **CORS Restrictions**: The Cloudflare Worker handles CORS properly, providing better error feedback. Ensure stable internet for SDP exchange.
- **File Size**: Large files may require longer transfer times due to chunking and WebRTC buffer limits.
- **Browser Compatibility**: Requires WebRTC support; older browsers may not work.
- **Single Peer Connection**: Currently supports one-to-one chat; multi-peer support is not implemented.

## Troubleshooting
- **Connection Timeout**: Ensure both peers use the same Peer ID and have internet access. Check browser console for errors.
- **File Transfer Fails**: Verify file size and type. For large files, ensure a stable connection. Check console for chunk-related errors.
- **Progress Bar Issues**: Confirm Bootstrap CSS is loaded. If text is not visible, inspect the progress bar's height and font size.
- **UI Not Rendering**: Ensure jQuery, Bootstrap, and Font Awesome CDNs are accessible.

## Contributing
Contributions are welcome! Please fork the repository, create a feature branch, and submit a pull request with your changes. Ensure code follows the existing style and includes relevant tests.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgments
- Created by **Chandan Maurya**.
- Built with WebRTC, Bootstrap, jQuery, and Font Awesome.
- Inspired by WhatsApp's chat interface for a familiar user experience.
