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

## Environment files

Real `.env` files are ignored by Git so secrets do not get pushed accidentally.

Use these templates:

- `backend/.env.railway.example` for Railway backend variables.
- `frontend/.env.vercel.example` for Vercel frontend variables.

For local development, copy the example files:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

For deployment, paste or import the matching template values into Railway and Vercel, then replace the placeholder URLs with your real deployment URLs.
