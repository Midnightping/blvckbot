'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Copy, Link2, Loader2, MessageSquareText, Shield, Sparkles, Smartphone } from 'lucide-react';
import { io } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

export default function Home() {
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');

  const userId = useMemo(() => {
    return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'guest';
  }, [name]);

  useEffect(() => {
    const socket = io(API_URL);

    socket.emit('join-user-room', userId);

    socket.on('pairing-code', ({ code }) => {
      setPairingCode(code);
      setStatus('code-ready');
      setMessage('Pairing code generated. Enter it in WhatsApp to link your device.');
    });

    socket.on('session-status', ({ status: nextStatus }) => {
      setStatus(nextStatus);
      if (nextStatus === 'connected') {
        setMessage('Your WhatsApp is connected to BlvckLink.');
      }
    });

    return () => socket.disconnect();
  }, [userId]);

  const startPairing = async () => {
    if (!name.trim() || !phoneNumber.trim()) {
      setMessage('Enter your name and phone number first.');
      return;
    }

    setStatus('loading');
    setPairingCode('');
    setMessage('Requesting pairing code...');

    try {
      const response = await fetch(`${API_URL}/api/pair/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, phoneNumber }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start pairing');
      }

      setPairingCode(data.code);
      setStatus('code-ready');
      setMessage('Pairing code generated. Enter it in WhatsApp to link your device.');
    } catch (error) {
      setStatus('error');
      setMessage(error.message);
    }
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(pairingCode);
    setMessage('Pairing code copied.');
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#312e81,transparent_34%),linear-gradient(135deg,#050505,#0b0b0f_45%,#111118)] text-white">
      <section className="mx-auto grid min-h-screen max-w-7xl items-center gap-10 px-6 py-10 lg:grid-cols-[1.05fr_0.95fr]">
        <div>
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/75 backdrop-blur">
            <Sparkles className="h-4 w-4 text-violet-300" />
            Multi-user WhatsApp automation
          </div>

          <h1 className="max-w-4xl text-5xl font-black tracking-tight sm:text-6xl lg:text-7xl">
            Meet <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-white bg-clip-text text-transparent">BlvckLink</span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-8 text-white/70">
            Link your WhatsApp from one device using a phone-number pairing code. BlvckLink gives each user a private bot session for anti-delete, view-once recovery, AI commands, stickers, and more.
          </p>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <Feature icon={<Shield />} title="Private Sessions" text="Each user gets their own WhatsApp session." />
            <Feature icon={<MessageSquareText />} title="Bot Commands" text="Use view-once, stickers, AI, and media tools." />
            <Feature icon={<Link2 />} title="Easy Pairing" text="No second phone needed. Use pairing code." />
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/[0.07] p-6 shadow-2xl shadow-violet-950/40 backdrop-blur-xl">
          <div className="mb-6 flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-violet-500/20 text-violet-200">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold">Link your WhatsApp</h2>
              <p className="text-sm text-white/55">Powered by BlvckBot</p>
            </div>
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-white/70">Display name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jason"
                className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-4 outline-none transition focus:border-violet-300/70"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-white/70">Phone number with country code</span>
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-4 transition focus-within:border-violet-300/70">
                <Smartphone className="h-5 w-5 text-white/45" />
                <input
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="2348012345678"
                  className="w-full bg-transparent outline-none"
                />
              </div>
            </label>

            <button
              onClick={startPairing}
              disabled={status === 'loading'}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 py-4 font-bold text-white shadow-lg shadow-violet-950/40 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === 'loading' ? <Loader2 className="h-5 w-5 animate-spin" /> : <Link2 className="h-5 w-5" />}
              Generate Pairing Code
            </button>
          </div>

          {pairingCode && (
            <div className="mt-6 rounded-3xl border border-violet-300/20 bg-violet-400/10 p-5">
              <p className="text-sm text-white/65">Your pairing code</p>
              <div className="mt-3 flex items-center justify-between gap-4">
                <code className="text-4xl font-black tracking-[0.18em] text-violet-100">{pairingCode}</code>
                <button onClick={copyCode} className="rounded-xl bg-white/10 p-3 transition hover:bg-white/20">
                  <Copy className="h-5 w-5" />
                </button>
              </div>
              <p className="mt-4 text-sm leading-6 text-white/65">
                Open WhatsApp, go to Linked Devices, choose Link with phone number, then enter this code.
              </p>
            </div>
          )}

          {status === 'connected' && (
            <div className="mt-5 flex items-center gap-2 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 px-4 py-3 text-emerald-200">
              <CheckCircle2 className="h-5 w-5" /> Connected successfully
            </div>
          )}

          {message && <p className="mt-5 text-sm text-white/60">{message}</p>}
        </div>
      </section>
    </main>
  );
}

function Feature({ icon, title, text }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur">
      <div className="mb-4 h-6 w-6 text-violet-200">{icon}</div>
      <h3 className="font-bold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-white/55">{text}</p>
    </div>
  );
}
