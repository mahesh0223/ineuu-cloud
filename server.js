const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});
const port = 3000;

// Support reading JSON data sent to the server
app.use(express.json());

// Keep track of online smartboards in memory for now
let connectedPanels = {};

// 1. HOME ENDPOINT
app.get('/', (req, res) => {
    res.send(`INEUU Cloud Core: ${Object.keys(connectedPanels).length} panels currently online.`);
});

// 2. LIVE WEBSOCKET CONNECTION LAYER
io.on('connection', (socket) => {
    console.log('⚡ A device is attempting to handshake...');

    // When an INEUU board registers itself on startup
    socket.on('register_panel', (data) => {
        const { hardware_id, school_id } = data;
        socket.join(`panel:${hardware_id}`); // Join a private room just for this board
        
        // Save the device state in memory
        connectedPanels[hardware_id] = {
            socketId: socket.id,
            school: school_id,
            status: "ONLINE",
            lastSeen: new Date()
        };

        console.log(`✅ Panel [${hardware_id}] registered successfully for School: ${school_id}`);
    });

    // Handle disconnecting
    socket.on('disconnect', () => {
        // Remove from online list when pipe closes
        for (let hardware_id in connectedPanels) {
            if (connectedPanels[hardware_id].socketId === socket.id) {
                console.log(`❌ Panel [${hardware_id}] went offline.`);
                delete connectedPanels[hardware_id];
                break;
            }
        }
    });
});

// 3. ADMIN PORTAL HOOK: REMOTE COMMAND EXECUTION
// This allows you to lock, wipe, or alert a panel from a web dashboard
app.post('/api/mdm/command', (req, res) => {
    const { target_hardware_id, action, message } = req.body;

    if (!connectedPanels[target_hardware_id]) {
        return res.status(404).json({ success: false, error: "Device is currently offline or not found." });
    }

    // Blast the command instantly down the open WebSocket pipe to that specific board
    io.to(`panel:${target_hardware_id}`).emit('mdm_execute', { action, message });
    
    console.log(`🚀 MDM Command [${action}] sent to panel: ${target_hardware_id}`);
    return res.json({ success: true, message: `Command broadcasted successfully.` });
});

// Turn the upgraded server on
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});