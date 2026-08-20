# CFPB Backend - Vercel Deployment

This is the backend service for the CFPB Portal automation using Playwright.

## 🚀 Deploy to Vercel

### Option 1: Using Vercel CLI (Recommended)

1. Install Vercel CLI globally:
```bash
npm install -g vercel
```

2. Navigate to the backend directory:
```bash
cd cfpb-backend
```

3. Login to Vercel:
```bash
vercel login
```

4. Deploy:
```bash
vercel --prod
```

### Option 2: Using Vercel Dashboard

1. Go to [vercel.com](https://vercel.com)
2. Click "Add New Project"
3. Import your Git repository
4. Set the **Root Directory** to `cfpb-backend`
5. Click "Deploy"

## ⚙️ Environment Variables

For local development, create `cfpb-backend/.env` with the webhook URL:

```env
N8N_WEBHOOK_URL=https://your-n8n-host/webhook/your-webhook-id
```

The backend loads this file with `dotenv` at startup. Restart the backend after changing it. Keep `.env` out of source control and use Vercel's Environment Variables settings for deployments.

After deployment, add these environment variables in Vercel Dashboard:

- `N8N_WEBHOOK_URL` - Your N8N webhook URL (if different from default)

## 🔧 Configuration Notes

- **Memory**: 3008 MB (maximum for serverless functions)
- **Timeout**: 300 seconds (5 minutes) - Requires Pro/Enterprise plan
- **Playwright**: Chromium browser is installed during build

## ⚠️ Important Limitations

1. **Free Plan Limitation**: Vercel free plan has 10-second timeout. You need **Pro or Enterprise** plan for 300-second timeout.

2. **Cold Starts**: First request after inactivity may be slower due to serverless function cold start.

3. **Concurrent Sessions**: The current implementation uses in-memory session state, so only one session per deployment instance.

## 🔗 After Deployment

Once deployed, you'll get a URL like: `https://your-project.vercel.app`

Update your frontend's API endpoint in `cfpb-portal/src/App.jsx`:

```javascript
const API = 'https://your-backend.vercel.app/api';
```

Or use environment variables in your frontend.

## 🧪 Testing

Test your deployed backend:

```bash
curl -X POST https://your-backend.vercel.app/start
```

## 📝 Deployment Checklist

- [ ] Vercel account created
- [ ] Pro/Enterprise plan activated (for longer timeout)
- [ ] Backend deployed successfully
- [ ] N8N webhook URL configured
- [ ] Frontend updated with backend URL
- [ ] Test `/start` endpoint
- [ ] Test full workflow with verification code
