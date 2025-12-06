// Socket.io client connection - auto-detect server URL
const socket = io(window.location.origin);

// DOM Elements
const authScreen = document.getElementById('auth-screen');
const chatApp = document.getElementById('chat-app');
const usernameInput = document.getElementById('username-input');
const loginBtn = document.getElementById('login-btn');
const currentUsername = document.getElementById('current-username');
const currentUserInitial = document.getElementById('current-user-initial');
const currentUserAvatar = document.getElementById('current-user-avatar');
const contactsList = document.getElementById('contacts-list');
const searchUsers = document.getElementById('search-users');
const emptyState = document.getElementById('empty-state');
const chatWindow = document.getElementById('chat-window');
const chatUsername = document.getElementById('chat-username');
const chatUserInitial = document.getElementById('chat-user-initial');
const chatStatus = document.getElementById('chat-status');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPicker = document.getElementById('emoji-picker');
const typingIndicator = document.getElementById('typing-indicator');
const fileBtn = document.getElementById('file-btn');
const fileInput = document.getElementById('file-input');
const mobileBackBtn = document.getElementById('mobile-back-btn');
const sidebar = document.querySelector('.sidebar');

// State
let currentUser = null;
let currentPassword = null;
let activeChat = null;
let users = new Map();
let messageHistory = new Map();
let typingTimeout = null;

// File transfer state
const pendingTransfers = new Map(); // transferId -> { chunks: Map, metadata: {} }
const CHUNK_SIZE = 512 * 1024; // 512KB chunks for better stability

// Utility Functions
function getInitial(username) {
    return username.charAt(0).toUpperCase();
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
}

function getAvatarColor(username) {
    const colors = [
        'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
        'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
        'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
        'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
        'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
    ];
    const index = username.charCodeAt(0) % colors.length;
    return colors[index];
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function generateTransferId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Authentication
const passwordInput = document.getElementById('password-input');

loginBtn.addEventListener('click', handleLogin);
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
});
if (passwordInput) {
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLogin();
    });
}

function handleLogin() {
    const username = usernameInput.value.trim();
    const password = passwordInput ? passwordInput.value.trim() : '';

    if (username.length < 2) {
        alert('Username must be at least 2 characters');
        return;
    }

    if (passwordInput && password.length < 4) {
        alert('Password must be at least 4 characters');
        return;
    }

    currentUser = username;
    currentPassword = password; // Store for reconnection
    socket.emit('user:login', { username, password });
}

socket.on('login:success', ({ username }) => {
    authScreen.classList.add('hidden');
    chatApp.classList.remove('hidden');
    currentUsername.textContent = username;
    currentUserInitial.textContent = getInitial(username);
    currentUserAvatar.style.background = getAvatarColor(username);
});

socket.on('login:error', ({ message }) => {
    alert(message);
    currentUser = null;
    currentPassword = null;
});

// Socket Event Handlers
socket.on('users:list', (usersList) => {
    users.clear();
    usersList.forEach(user => {
        if (user.username !== currentUser) {
            users.set(user.userId, user);
        }
    });
    renderContacts();
});

socket.on('user:online', ({ userId, username, online }) => {
    if (username !== currentUser) {
        users.set(userId, { userId, username, online, lastSeen: new Date() });
        renderContacts();
        if (activeChat === userId) {
            updateChatStatus(online);
        }
    }
});

socket.on('message:receive', (messageData) => {
    const { from, id } = messageData;

    if (!messageHistory.has(from)) {
        messageHistory.set(from, []);
    }
    messageHistory.get(from).push(messageData);

    if (activeChat === from) {
        displayMessage(messageData, 'received');
        socket.emit('message:read', { messageId: id, from });
    }

    renderContacts();
});

socket.on('message:sent', (messageData) => {
    const { to } = messageData;
    if (!messageHistory.has(to)) {
        messageHistory.set(to, []);
    }
    messageHistory.get(to).push(messageData);
});

socket.on('typing:indicator', ({ from, typing }) => {
    if (activeChat === from) {
        if (typing) {
            typingIndicator.classList.remove('hidden');
        } else {
            typingIndicator.classList.add('hidden');
        }
    }
});

socket.on('message:read:confirm', ({ messageId }) => {
    const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageEl) {
        const checkmark = messageEl.querySelector('.read-indicator');
        if (checkmark) {
            checkmark.style.color = '#10b981';
        }
    }
});

socket.on('messages:history:response', ({ userId, messages }) => {
    messageHistory.set(userId, messages);
    if (activeChat === userId) {
        renderMessages(messages);
    }
});

// ==========================================
// CHUNKED FILE TRANSFER HANDLERS
// ==========================================

// Handle incoming file notification
socket.on('file:incoming', ({ transferId, from, fromUsername, metadata }) => {
    console.log(`📥 Incoming file: ${metadata.name} from ${fromUsername}`);

    pendingTransfers.set(transferId, {
        chunks: new Map(),
        metadata: metadata,
        from: from,
        fromUsername: fromUsername,
        totalChunks: metadata.totalChunks,
        receivedChunks: 0
    });

    // Show incoming file message with progress
    if (activeChat === from) {
        showIncomingFileProgress(transferId, metadata);
    }
});

// Handle incoming file chunk
socket.on('file:chunk', ({ transferId, chunkIndex, chunk, progress }) => {
    const transfer = pendingTransfers.get(transferId);
    if (transfer) {
        transfer.chunks.set(chunkIndex, chunk);
        transfer.receivedChunks++;

        // Update progress bar
        updateFileProgress(transferId, progress);
    }
});

// Handle file transfer complete (receiving)
socket.on('file:complete', ({ transferId }) => {
    const transfer = pendingTransfers.get(transferId);
    if (transfer && transfer.chunks) {
        // Reassemble the file from chunks
        const chunks = [];
        for (let i = 0; i < transfer.totalChunks; i++) {
            const base64 = transfer.chunks.get(i) || '';
            const binary = atob(base64);
            const len = binary.length;
            const buffer = new Uint8Array(len);
            for (let j = 0; j < len; j++) {
                buffer[j] = binary.charCodeAt(j);
            }
            chunks.push(buffer);
        }

        // Create Blob URL (much more reliable for large files/mobile)
        const blob = new Blob(chunks, { type: transfer.metadata.type });
        const dataUrl = URL.createObjectURL(blob);

        // Create file data object
        const fileData = {
            originalname: transfer.metadata.name,
            size: transfer.metadata.size,
            mimetype: transfer.metadata.type,
            dataUrl: dataUrl
        };

        // Replace progress with actual file display
        replaceProgressWithFile(transferId, fileData, transfer.from);

        // Clean up
        pendingTransfers.delete(transferId);
    }
});

// Handle upload progress (sending)
socket.on('file:progress', ({ transferId, progress }) => {
    updateFileProgress(transferId, progress);
});

// Handle file:ready to start sending chunks
socket.on('file:ready', ({ transferId }) => {
    const transfer = pendingTransfers.get(transferId);
    if (transfer && transfer.file) {
        sendFileChunks(transferId, transfer.file);
    }
});

// ==========================================
// FILE TRANSFER UI FUNCTIONS
// ==========================================

function showIncomingFileProgress(transferId, metadata) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message received';
    messageDiv.id = `file-${transferId}`;

    messageDiv.innerHTML = `
        <div class="message-bubble">
            <div class="file-transfer-progress">
                <div class="file-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" stroke="currentColor" stroke-width="2"/>
                        <path d="M13 2v7h7" stroke="currentColor" stroke-width="2"/>
                    </svg>
                </div>
                <div class="file-info">
                    <div class="file-name">${escapeHtml(metadata.name)}</div>
                    <div class="file-size">${formatFileSize(metadata.size)}</div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-${transferId}" style="width: 0%"></div>
                    </div>
                    <div class="progress-text" id="progress-text-${transferId}">Receiving... 0%</div>
                </div>
            </div>
        </div>
    `;

    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function showSendingFileProgress(transferId, file) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message sent';
    messageDiv.id = `file-${transferId}`;

    messageDiv.innerHTML = `
        <div class="message-bubble">
            <div class="file-transfer-progress">
                <div class="file-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" stroke="currentColor" stroke-width="2"/>
                        <path d="M13 2v7h7" stroke="currentColor" stroke-width="2"/>
                    </svg>
                </div>
                <div class="file-info">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-size">${formatFileSize(file.size)}</div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-${transferId}" style="width: 0%"></div>
                    </div>
                    <div class="progress-text" id="progress-text-${transferId}">Sending... 0%</div>
                </div>
            </div>
        </div>
    `;

    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function updateFileProgress(transferId, progress) {
    const progressBar = document.getElementById(`progress-${transferId}`);
    const progressText = document.getElementById(`progress-text-${transferId}`);

    if (progressBar) {
        progressBar.style.width = `${progress}%`;
    }
    if (progressText) {
        progressText.textContent = `${progress}%`;
    }
}

function replaceProgressWithFile(transferId, fileData, from) {
    const messageDiv = document.getElementById(`file-${transferId}`);
    if (!messageDiv) return;

    const type = from === currentUser.toLowerCase() ? 'sent' : 'received';
    messageDiv.className = `message ${type}`;

    const { originalname, size, mimetype, dataUrl } = fileData;
    const isImage = mimetype.startsWith('image/');
    const isVideo = mimetype.startsWith('video/');

    let content = '';

    if (isImage) {
        content = `
            <img src="${dataUrl}" alt="${originalname}" class="file-preview" onclick="window.open('${dataUrl}', '_blank')" />
        `;
    } else if (isVideo) {
        content = `
            <video controls class="file-preview">
                <source src="${dataUrl}" type="${mimetype}">
                Your browser does not support the video tag.
            </video>
            <div style="margin-top: 8px; font-size: 0.85rem; opacity: 0.8;">${escapeHtml(originalname)} (${formatFileSize(size)})</div>
        `;
    } else {
        content = `
            <div class="file-message">
                <div class="file-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" stroke="currentColor" stroke-width="2"/>
                        <path d="M13 2v7h7" stroke="currentColor" stroke-width="2"/>
                    </svg>
                </div>
                <div class="file-info">
                    <div class="file-name">${escapeHtml(originalname)}</div>
                    <div class="file-size">${formatFileSize(size)}</div>
                </div>
                <a href="${dataUrl}" download="${originalname}" class="file-download">Download</a>
            </div>
        `;
    }

    messageDiv.innerHTML = `
        <div class="message-bubble">
            ${content}
            <div class="message-time">${formatTime(Date.now())}</div>
        </div>
    `;

    scrollToBottom();
}

// ==========================================
// FILE SENDING LOGIC (CHUNKED)
// ==========================================

async function sendFileChunked(file) {
    if (!activeChat) {
        alert('Please select a contact first');
        return;
    }

    const transferId = generateTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const metadata = {
        name: file.name,
        size: file.size,
        type: file.type,
        totalChunks: totalChunks
    };

    // Store file reference for when server is ready
    pendingTransfers.set(transferId, { file, metadata, to: activeChat });

    // Show progress UI
    showSendingFileProgress(transferId, file);

    // Start file transfer
    socket.emit('file:start', {
        transferId,
        metadata,
        to: activeChat
    });
}

async function sendFileChunks(transferId, file) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        // Convert chunk to base64
        const base64Chunk = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.readAsDataURL(chunk);
        });

        // Send chunk and wait for acknowledgment
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.warn('⚠️ Chunk ack timeout - proceeding anyway');
                    resolve();
                }, 5000); // 5s timeout

                socket.emit('file:chunk', {
                    transferId,
                    chunkIndex: i,
                    chunk: base64Chunk,
                    isLast: i === totalChunks - 1
                }, (response) => {
                    clearTimeout(timeout);
                    if (response && response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve();
                    }
                });
            });
        } catch (error) {
            // Handle "Transfer not found" (server restart/timeout) -> Auto-recover
            if (error.message.includes('Transfer not found')) {
                console.warn('⚠️ Server lost transfer state. Attempting to recover...');
                const transferData = pendingTransfers.get(transferId);

                if (transferData) {
                    // Re-initialize transfer on server
                    socket.emit('file:start', {
                        transferId,
                        metadata: transferData.metadata,
                        to: transferData.to
                    });
                    // Exit this loop - the 'file:ready' event will trigger a NEW loop
                    return;
                }
            }

            console.error('File transfer error:', error);
            alert(`Transfer failed: ${error.message}`);
            pendingTransfers.delete(transferId);
            return;
        }

        // Small delay to let UI breathe
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    // Clean up local reference
    pendingTransfers.delete(transferId);
}

// Contact List
function renderContacts() {
    const searchTerm = searchUsers.value.toLowerCase();
    contactsList.innerHTML = '';

    const filteredUsers = Array.from(users.values()).filter(user =>
        user.username.toLowerCase().includes(searchTerm)
    );

    filteredUsers.forEach(user => {
        const contactItem = document.createElement('div');
        contactItem.className = 'contact-item';
        if (activeChat === user.userId) {
            contactItem.classList.add('active');
        }

        contactItem.innerHTML = `
            <div class="avatar" style="background: ${getAvatarColor(user.username)}">
                <span>${getInitial(user.username)}</span>
            </div>
            <div class="contact-info">
                <h4>${user.username}</h4>
                <span class="status ${user.online ? 'online' : ''}">
                    ${user.online ? 'Online' : 'Offline'}
                </span>
            </div>
        `;

        contactItem.addEventListener('click', () => openChat(user));
        contactsList.appendChild(contactItem);
    });
}

searchUsers.addEventListener('input', renderContacts);

// Chat Window
function openChat(user) {
    activeChat = user.userId;

    emptyState.classList.add('hidden');
    chatWindow.classList.remove('hidden');
    chatUsername.textContent = user.username;
    chatUserInitial.textContent = getInitial(user.username);
    document.getElementById('chat-user-avatar').style.background = getAvatarColor(user.username);
    updateChatStatus(user.online);

    socket.emit('messages:history', { userId: user.userId });
    renderContacts();
    messageInput.focus();

    // Mobile: Hide sidebar and show back button
    if (window.innerWidth <= 768) {
        sidebar.classList.add('hidden-mobile');
        mobileBackBtn.style.display = 'flex';
    }
}

// Mobile back button handler
if (mobileBackBtn) {
    mobileBackBtn.addEventListener('click', () => {
        sidebar.classList.remove('hidden-mobile');
        chatWindow.classList.add('hidden');
        emptyState.classList.remove('hidden');
        mobileBackBtn.style.display = 'none';
        activeChat = null;
    });
}

// Handle window resize
window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
        sidebar.classList.remove('hidden-mobile');
        mobileBackBtn.style.display = 'none';
        if (activeChat) {
            chatWindow.classList.remove('hidden');
            emptyState.classList.add('hidden');
        }
    }
});

function updateChatStatus(online) {
    chatStatus.textContent = online ? 'Online' : 'Offline';
    chatStatus.style.color = online ? 'var(--status-online)' : 'var(--text-muted)';
}

function renderMessages(messages) {
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
        const type = msg.from === currentUser.toLowerCase() ? 'sent' : 'received';
        displayMessage(msg, type);
    });
    scrollToBottom();
}

function displayMessage(messageData, type) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    messageDiv.setAttribute('data-message-id', messageData.id);

    const readIndicator = type === 'sent'
        ? `<span class="read-indicator" style="color: ${messageData.read ? '#10b981' : 'inherit'}">✓</span>`
        : '';

    let messageContent = '';

    if (messageData.fileData) {
        const { originalname, size, mimetype, dataUrl } = messageData.fileData;
        const isImage = mimetype && mimetype.startsWith('image/');
        const isVideo = mimetype && mimetype.startsWith('video/');

        if (isImage && dataUrl) {
            messageContent = `<img src="${dataUrl}" alt="${originalname}" class="file-preview" onclick="window.open('${dataUrl}', '_blank')" />`;
        } else if (isVideo && dataUrl) {
            messageContent = `
                <video controls class="file-preview">
                    <source src="${dataUrl}" type="${mimetype}">
                    Your browser does not support the video tag.
                </video>
                <div style="margin-top: 8px; font-size: 0.85rem; opacity: 0.8;">${escapeHtml(originalname)} (${formatFileSize(size)})</div>
            `;
        } else if (dataUrl) {
            messageContent = `
                <div class="file-message">
                    <div class="file-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" stroke="currentColor" stroke-width="2"/>
                            <path d="M13 2v7h7" stroke="currentColor" stroke-width="2"/>
                        </svg>
                    </div>
                    <div class="file-info">
                        <div class="file-name">${escapeHtml(originalname)}</div>
                        <div class="file-size">${formatFileSize(size)}</div>
                    </div>
                    <a href="${dataUrl}" download="${originalname}" class="file-download">Download</a>
                </div>
            `;
        }
    }

    const textMessage = messageData.message ? `<div class="message-text">${escapeHtml(messageData.message)}</div>` : '';

    messageDiv.innerHTML = `
        <div class="message-bubble">
            ${messageContent}
            ${textMessage}
            <div class="message-time">
                ${formatTime(messageData.timestamp)}
                ${readIndicator}
            </div>
        </div>
    `;

    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Send Message
sendBtn.addEventListener('click', () => sendMessage());
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function sendMessage(fileData = null) {
    const message = messageInput.value.trim();

    if ((!message && !fileData) || !activeChat) return;

    const messageData = {
        to: activeChat,
        message: message || '',
        timestamp: Date.now(),
        fileData: fileData
    };

    socket.emit('message:send', messageData);

    displayMessage({
        ...messageData,
        from: currentUser.toLowerCase(),
        id: Date.now(),
        read: false
    }, 'sent');

    messageInput.value = '';
    socket.emit('typing:stop', { to: activeChat });
}

// File Upload - CHUNKED TRANSFER
fileBtn.addEventListener('click', () => {
    if (fileInput) {
        fileInput.click();
    }
});

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!activeChat) {
        alert('Please select a contact first');
        fileInput.value = '';
        return;
    }

    console.log(`📤 Sending file: ${file.name} (${formatFileSize(file.size)})`);

    // Use chunked transfer for all files
    sendFileChunked(file);

    fileInput.value = '';
});

// Typing Indicator
messageInput.addEventListener('input', () => {
    if (!activeChat) return;

    socket.emit('typing:start', { to: activeChat });

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing:stop', { to: activeChat });
    }, 1000);
});

// Emoji Picker
emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPicker.classList.toggle('hidden');
});

emojiPicker.addEventListener('click', (e) => {
    if (e.target.textContent.trim().length === 2) {
        messageInput.value += e.target.textContent;
        messageInput.focus();
        emojiPicker.classList.add('hidden');
    }
});

document.addEventListener('click', (e) => {
    if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) {
        emojiPicker.classList.add('hidden');
    }
});

// Connection Status
socket.on('connect', () => {
    console.log('✅ Connected to server');
    if (currentUser && currentPassword) {
        console.log('🔄 Auto-reconnecting...');
        socket.emit('user:login', { username: currentUser, password: currentPassword });
    }
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
    // Optional: Show disconnection UI
});

socket.on('error', (error) => {
    console.error('Socket error:', error);
    // Don't alert on simple disconnects/reconnects to avoid spam
    if (error.message !== 'xhr poll error') {
        console.warn(error.message);
    }
});
