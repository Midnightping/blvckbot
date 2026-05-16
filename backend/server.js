import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { startPairing, getSessionStatus, disconnectSession } from './src/sessionManager.js';
import { syncAllUsersToCloudinary } from './src/cloudinaryService.js';

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ name: 'BlvckBot API', status: 'online' });
});

app.post('/api/pair/start', async (req, res) => {
    try {
        const { userId, phoneNumber, method } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        if (method === 'code' && !phoneNumber) {
            return res.status(400).json({ error: 'phoneNumber is required for pairing code' });
        }

        const result = await startPairing(userId, phoneNumber, io, method || 'code');
        res.json(result);
    } catch (error) {
        console.error('[API] Pairing failed:', error);
        res.status(500).json({ error: error.message || 'Failed to start pairing' });
    }
});

app.get('/api/session/:userId', (req, res) => {
    res.json(getSessionStatus(req.params.userId));
});

app.post('/api/session/:userId/disconnect', async (req, res) => {
    try {
        await disconnectSession(req.params.userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to disconnect session' });
    }
});

io.on('connection', (socket) => {
    socket.on('join-user-room', (userId) => {
        socket.join(`user:${userId}`);
    });
});

// Start hourly sync (3600000ms = 1 hour)
setInterval(syncAllUsersToCloudinary, 3600000);

server.listen(PORT, () => {
    console.log(`[BlvckBot] API running on port ${PORT}`);
});
