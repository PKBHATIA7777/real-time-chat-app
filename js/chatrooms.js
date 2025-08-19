import { app } from "./firebase-config.js";
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  limit,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const db = getFirestore(app);
const auth = getAuth(app);

let currentUserId = null;
let chatroomsData = new Map(); // Store room data keyed by roomId

const chatroomsList = document.getElementById("chatroomsList");
const roomSearchInput = document.getElementById("roomSearchInput");
const btnCreateRoom = document.getElementById("btnCreateRoom");

// --- Auth & Init ---
signInAnonymously(auth).catch(console.error);

onAuthStateChanged(auth, async user => {
  if (user) {
    currentUserId = user.uid;
    await initChatrooms();
  }
});

// --- Initialize chatrooms list listener ---
async function initChatrooms() {
  // Listen for memberships of current user
  const membershipsRef = collection(db, "chatrooms");
  // You might want to structure with member info, here simplified example assumes user can see all rooms

  // Listener for rooms where user is a member
  const roomsQuery = query(
    collection(db, "chatrooms"),
    orderBy("createdAt", "desc")
  );

  onSnapshot(roomsQuery, snapshot => {
    // Update chatroomsData
    snapshot.docChanges().forEach(change => {
      const roomId = change.doc.id;
      const data = change.doc.data();
      if (change.type === "removed") {
        chatroomsData.delete(roomId);
        renderChatrooms();
      } else {
        chatroomsData.set(roomId, { ...data, id: roomId });
        // After updating room info, fetch last message & mute & reads asynchronously
        loadRoomAdditionalData(roomId);
      }
    });

    renderChatrooms(); // Initial render
  });
}

// --- Load last message, mute status, and unread count for a room ---
async function loadRoomAdditionalData(roomId) {
  try {
    // Load last message
    const messagesRef = collection(db, `chatrooms/${roomId}/messages`);
    const lastMsgQuery = query(messagesRef, orderBy("createdAt", "desc"), limit(1));
    const lastMsgSnap = await getDoc(lastMsgQuery);

    let lastMessage = null;
    if (!lastMsgSnap.empty) {
      lastMsgSnap.forEach(doc => {
        lastMessage = doc.data();
      });
    }

    // Load mute status
    const muteDoc = await getDoc(doc(db, "mutes", `${currentUserId}_${roomId}`));
    const isMuted = muteDoc.exists() ? muteDoc.data().muted === true : false;

    // Load unread count using lastReadTimestamp
    const readDoc = await getDoc(doc(db, "reads", `${currentUserId}_${roomId}`));
    const lastReadTimestamp = readDoc.exists() ? readDoc.data().lastReadTimestamp : null;

    // Compute unread count by querying messages newer than lastReadTimestamp
    let unreadCount = 0;
    if (lastReadTimestamp) {
      const unreadQuery = query(
        collection(db, `chatrooms/${roomId}/messages`),
        where("createdAt", ">", lastReadTimestamp)
      );
      const unreadSnap = await getDoc(unreadQuery);
      unreadCount = unreadSnap.size;
    }

    // Update local data and re-render list
    const roomData = chatroomsData.get(roomId) || {};
    chatroomsData.set(roomId, {
      ...roomData,
      lastMessage,
      isMuted,
      unreadCount
    });

    renderChatrooms();
  } catch (err) {
    console.error("Error loading room extra data:", err);
  }
}

// --- Render chatrooms list ---
function renderChatrooms() {
  chatroomsList.innerHTML = "";

  // Get filter value
  const filterText = roomSearchInput.value.toLowerCase().trim();

  [...chatroomsData.values()]
    .filter(room => room.title.toLowerCase().includes(filterText))
    .forEach(room => {
      const elem = document.createElement("div");
      elem.classList.add("room-item");

      elem.innerHTML = `
        <div class="room-left">
          <div class="room-title">${room.title}</div>
          <div class="room-last-message">${room.lastMessage ? room.lastMessage.text || 'Image' : ''}</div>
        </div>
        <div class="room-right">
          <div class="room-timestamp">${room.lastMessage && room.lastMessage.createdAt ? new Date(room.lastMessage.createdAt.seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ''}</div>
          ${room.unreadCount > 0 && !room.isMuted ? `<div class="unread-count">${room.unreadCount}</div>` : ''}
          <button class="mute-toggle ${room.isMuted ? 'muted' : 'unmuted'}" title="${room.isMuted ? 'Unmute' : 'Mute'}">&#128263;</button>
        </div>
      `;

      // Click to open the room (adjust URL per your routing)
      elem.addEventListener("click", () => {
        window.location.href = `chat.html?roomId=${room.id}`;
      });

      // Mute toggle button
      const muteBtn = elem.querySelector(".mute-toggle");
      muteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        toggleMute(room.id, !room.isMuted);
      });

      chatroomsList.appendChild(elem);
    });
}

// --- Toggle mute status ---
async function toggleMute(roomId, mute) {
  try {
    await setDoc(doc(db, "mutes", `${currentUserId}_${roomId}`), {
      muted: mute
    });
    // Update locally for instant feedback
    const room = chatroomsData.get(roomId);
    if (room) {
      room.isMuted = mute;
      chatroomsData.set(roomId, room);
      renderChatrooms();
    }
  } catch (err) {
    console.error("Failed to update mute status", err);
  }
}

// --- Search filter input ---
roomSearchInput.addEventListener("input", () => {
  renderChatrooms();
});

// --- Create room button ---
btnCreateRoom.addEventListener("click", () => {
  alert("Room creation UI not implemented yet — next steps.");
});
