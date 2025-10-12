# WaveLite Chat - Cloudflare Pages Deployment Guide

This guide explains how to deploy the WaveLite Chat application to Cloudflare Pages with the new signaling system.

## Prerequisites

1. A Cloudflare account
2. The WaveLite Chat project files
3. Git repository (GitHub, GitLab, or Bitbucket)

## Deployment Steps

### 1. Prepare Your Repository

1. Upload all project files to your Git repository
2. Ensure the `functions/` directory contains:
   - `functions/signaling.js` - KV-based signaling function
3. Make sure all Google Forms references have been removed
4. Verify the function structure is correct for Cloudflare Pages
5. **Important**: Set up Cloudflare KV storage for persistent signaling data

### 2. Deploy to Cloudflare Pages

1. **Login to Cloudflare Dashboard**
   - Go to [dash.cloudflare.com](https://dash.cloudflare.com)
   - Navigate to "Pages" in the sidebar

2. **Create a New Project**
   - Click "Create a project"
   - Connect your Git repository
   - Select the repository containing WaveLite Chat

3. **Configure Build Settings**
   - **Framework preset**: None (or Static Site)
   - **Build command**: (leave empty)
   - **Build output directory**: `/` (root directory)
   - **Root directory**: (leave empty)

4. **Deploy**
   - Click "Save and Deploy"
   - Wait for the deployment to complete

### 3. Set Up KV Storage

1. **Create KV Namespace**
   - In your Cloudflare dashboard, go to "Workers & Pages" > "KV"
   - Click "Create a namespace"
   - Name it `SIGNALING_KV` (or any name you prefer)
   - Note the namespace ID

2. **Bind KV to Pages Function**
   - Go to your Pages project settings
   - Navigate to "Settings" > "Functions"
   - Add a KV namespace binding:
     - Variable name: `SIGNALING_KV`
     - KV namespace: Select the namespace you created
   - Save the settings

3. **Redeploy**
   - Trigger a new deployment to apply the KV binding
   - The function will now have access to persistent storage

### 4. Verify Deployment

1. **Test the Signaling Function**
   - Open two browser tabs/windows to `https://your-domain.pages.dev/`
   - In the first tab, enter a peer ID (e.g., "alice") and click "Connect"
   - In the second tab, enter the same peer ID and click "Join"
   - Verify the connection establishes successfully
   - Check browser console for any errors

2. **Test the Main Application**
   - Try connecting with two different browsers/tabs
   - Test file sharing and messaging functionality
   - Verify that polling stops after data is consumed

## Configuration

### Environment Variables (Optional)

If you need to configure any environment variables:

1. Go to your Pages project settings
2. Navigate to "Settings" > "Environment variables"
3. Add any required variables

### Custom Domain (Optional)

1. Go to your Pages project settings
2. Navigate to "Custom domains"
3. Add your custom domain
4. Follow the DNS configuration instructions

## Troubleshooting

### Common Issues

1. **KV Storage Not Configured Error**
   - **Cause**: SIGNALING_KV environment variable not set
   - **Solution**: Set up KV storage and bind it to the Pages function
   - **Check**: Verify KV namespace is created and bound in Pages settings
   - **Test**: Check function logs for KV-related errors

2. **405 Method Not Allowed Error**
   - **Cause**: Function not properly deployed or incorrect structure
   - **Solution**: Ensure the KV-based function is in the correct location
   - **Check**: Verify `functions/signaling.js` exists and is properly deployed
   - **Test**: Check that both GET and POST requests are supported

3. **Signaling Function Not Working**
   - Check that the function file exists in your repository:
     - `functions/signaling.js` - KV-based signaling function
   - Verify the function is deployed by checking the Functions tab in Pages
   - Check browser console for CORS errors
   - Verify KV storage is properly configured
   - Test with two browser tabs to verify peer-to-peer communication

4. **WebRTC Connection Fails**
   - Ensure both clients are using HTTPS
   - Check STUN server configuration
   - Verify signaling data is being exchanged (check network tab)
   - Test signaling endpoints individually

5. **File Transfer Issues**
   - Check browser console for chunk transfer errors
   - Verify data channel is properly established
   - Test with smaller files first

### Debug Mode

To enable debug logging:

1. Open browser developer tools
2. Check the Console tab for detailed logs
3. Use the Network tab to monitor signaling requests

## Security Considerations

1. **CORS Configuration**: The signaling function allows all origins (`*`). For production, consider restricting this to your domain.

2. **Rate Limiting**: Consider implementing rate limiting for the signaling endpoints to prevent abuse.

3. **Data Retention**: Signaling data is automatically cleaned up after 5 minutes, but consider implementing additional cleanup mechanisms.

## Performance Optimization

1. **KV Storage**: For high-traffic applications, consider using Cloudflare KV for persistent signaling data storage.

2. **Durable Objects**: For real-time features, consider using Durable Objects for stateful signaling.

3. **Caching**: Implement appropriate caching headers for static assets.

## Monitoring

1. **Analytics**: Enable Cloudflare Analytics to monitor usage
2. **Logs**: Use Cloudflare Workers Analytics to monitor function performance
3. **Alerts**: Set up alerts for function errors or high error rates

## Support

For issues with this deployment:

1. Check the Cloudflare Pages documentation
2. Review the browser console for errors
3. Test the signaling function independently
4. Verify all files are properly deployed

## Migration from Google Forms

If migrating from the Google Forms version:

1. Ensure all Google Forms URLs are removed
2. Update any hardcoded references to the old system
3. Test thoroughly with the new signaling system
4. Update any documentation or user guides
