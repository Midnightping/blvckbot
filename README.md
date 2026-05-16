# BlvckLink

BlvckLink is a multi-user WhatsApp bot platform powered by BlvckBot.

## Structure

- `backend` - Express API, Socket.IO, and WhatsApp session manager
- `frontend` - Next.js landing page and pairing interface

## Local setup

### Backend

```bash
cd backend
npm install
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Set `NEXT_PUBLIC_API_URL` in the frontend environment to your backend URL.

## Deployment

- Deploy `backend` to Railway.
- Deploy `frontend` to Vercel.
- Set `FRONTEND_URL` on Railway to your Vercel URL.
- Set `NEXT_PUBLIC_API_URL` on Vercel to your Railway backend URL.
