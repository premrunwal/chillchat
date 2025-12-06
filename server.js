const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 10 * 1024 * 1024 // 10MB per chunk max
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// In-memory storage
const users = new Map(); // userId -> { username, socketId, online }
const messages = []; // Array of all messages
const fileTransfers = new Map(); // Global file transfers storage

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // User registration/login
    socket.on('user:login', ({ username, password }) => {
        const userId = username.toLowerCase();
        const existingUser = users.get(userId);

        if (existingUser) {
            // Verify password
            if (existingUser.password !== password) {
                socket.emit('login:error', { message: 'Incorrect password' });
                return;
            }
            
            // Update connection info
            existingUser.socketId = socket.id;
            existingUser.online = true;
            existingUser.lastSeen = new Date();
            users.set(userId, existingUser);
        } else {
            // Register new user
            users.set(userId, {
                username,
                password, // Store password (in-memory only)
                socketId: socket.id,
                online: true,
                lastSeen: new Date()
            });
        }

        socket.userId = userId;
        socket.username = username;

        // Send success and existing users list
        socket.emit('login:success', { username });

        const usersList = Array.from(users.entries()).map(([id, user]) => ({
            userId: id,
            username: user.username,
            online: user.online,
            lastSeen: user.lastSeen
        }));

        socket.emit('users:list', usersList);

        // Broadcast to all clients that a new user is online
        io.emit('user:online', {
            userId,
            username,
            online: true
        });

        console.log(`User logged in: ${username}`);
    });

    // Regular text message
    socket.on('message:send', ({ to, message, timestamp, fileData }) => {
        const from = socket.userId;
        const fromUsername = socket.username;

        if (!from) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }

        const messageData = {
            id: Date.now() + Math.random(),
            from,
            fromUsername,
            to,
            message,
            timestamp,
            read: false,
            fileData: fileData || null
        };

        messages.push(messageData);

        // Send to recipient if online
        const recipient = users.get(to);
        if (recipient && recipient.online) {
            io.to(recipient.socketId).emit('message:receive', messageData);
        }

        // Confirm to sender
        socket.emit('message:sent', messageData);

        const logMessage = fileData ? `File: ${fileData.originalname}` : message;
        console.log(`Message from ${fromUsername} to ${to}: ${logMessage}`);
    });

    // ==========================================
    // CHUNKED FILE TRANSFER (Blip-style)
    // ==========================================

    // Start file transfer
    socket.on('file:start', ({ transferId, metadata, to }) => {
        const from = socket.userId;
        if (!from) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }

        console.log(`📁 File transfer started: ${metadata.name} (${(metadata.size / 1024 / 1024).toFixed(2)}MB) from ${socket.username} to ${to}`);

        fileTransfers.set(transferId, {
            chunks: new Map(),
            metadata: metadata,
            to: to,
            from: from,
            fromUsername: socket.username,
            totalChunks: metadata.totalChunks,
            receivedChunks: 0
        });

        // Notify sender that upload can start
        socket.emit('file:ready', { transferId });

        // Notify recipient that file is incoming
        const recipient = users.get(to);
        if (recipient && recipient.online) {
            io.to(recipient.socketId).emit('file:incoming', {
                transferId,
                from: from,
                fromUsername: socket.username,
                metadata: metadata
            });
        }
    });

    // Receive file chunk with flow control
    socket.on('file:chunk', ({ transferId, chunkIndex, chunk, isLast }, callback) => {
        const transfer = fileTransfers.get(transferId);
        if (!transfer) {
            if (callback) callback({ error: 'Transfer not found' });
            return;
        }

        // Store chunk
        transfer.chunks.set(chunkIndex, chunk);
        transfer.receivedChunks++;

        // Calculate progress
        const progress = Math.round((transfer.receivedChunks / transfer.totalChunks) * 100);

        // Send progress to sender
        socket.emit('file:progress', {
            transferId,
            progress,
            received: transfer.receivedChunks,
            total: transfer.totalChunks
        });

        // Forward chunk to recipient in real-time
        const recipient = users.get(transfer.to);
        if (recipient && recipient.online) {
            io.to(recipient.socketId).emit('file:chunk', {
                transferId,
                chunkIndex,
                chunk,
                isLast,
                progress
            });
        }

        // Acknowledgement for flow control
        if (callback) callback({ success: true });

        if (isLast) {
            console.log(`✅ File transfer completed: ${transfer.metadata.name}`);

            // Notify sender of completion
            socket.emit('file:complete', { transferId });

            // Notify recipient of completion
            if (recipient && recipient.online) {
                io.to(recipient.socketId).emit('file:complete', { transferId });
            }

            // Clean up transfer data after a short delay
            setTimeout(() => {
                fileTransfers.delete(transferId);
            }, 5000);
        }
    });

    // Cancel file transfer
    socket.on('file:cancel', ({ transferId }) => {
        const transfer = fileTransfers.get(transferId);
        if (transfer) {
            const recipient = users.get(transfer.to);
            if (recipient && recipient.online) {
                io.to(recipient.socketId).emit('file:cancelled', { transferId });
            }
            fileTransfers.delete(transferId);
            console.log(`❌ File transfer cancelled: ${transferId}`);
        }
    });

    // ==========================================
    // END CHUNKED FILE TRANSFER
    // ==========================================

    // Typing indicator
    socket.on('typing:start', ({ to }) => {
        const recipient = users.get(to);
        if (recipient && recipient.online) {
            io.to(recipient.socketId).emit('typing:indicator', {
                from: socket.userId,
                username: socket.username,
                typing: true
            });
        }
    });

    socket.on('typing:stop', ({ to }) => {
        const recipient = users.get(to);
        if (recipient && recipient.online) {
            io.to(recipient.socketId).emit('typing:indicator', {
                from: socket.userId,
                username: socket.username,
                typing: false
            });
        }
    });

    // Read receipt
    socket.on('message:read', ({ messageId, from }) => {
        const sender = users.get(from);
        if (sender && sender.online) {
            io.to(sender.socketId).emit('message:read:confirm', {
                messageId,
                readBy: socket.userId
            });
        }

        const msg = messages.find(m => m.id === messageId);
        if (msg) {
            msg.read = true;
        }
    });

    // Get message history
    socket.on('messages:history', ({ userId }) => {
        const currentUserId = socket.userId;

        const history = messages.filter(msg =>
            (msg.from === currentUserId && msg.to === userId) ||
            (msg.from === userId && msg.to === currentUserId)
        );

        socket.emit('messages:history:response', {
            userId,
            messages: history
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        if (socket.userId) {
            const user = users.get(socket.userId);
            if (user) {
                user.online = false;
                user.lastSeen = new Date();

                io.emit('user:offline', {
                    userId: socket.userId,
                    username: socket.username,
                    lastSeen: user.lastSeen
                });

                console.log(`User disconnected: ${socket.username}`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log('📁 Chunked file transfer enabled (Blip-style - no disk storage)');
    console.log('🔥 Supports files of ANY size!');
});
