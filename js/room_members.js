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
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const db = getFirestore(app);
const auth = getAuth(app);

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("roomId");

if (!roomId) {
  alert("Room ID not provided!");
  window.location.href = "chatrooms.html";
}

let currentUserId = null;
let roomAdmins = new Set();
let membersData = new Map();

const membersList = document.getElementById("membersList");
const backBtn = document.getElementById("backBtn");
const roomTitleEl = document.getElementById("roomTitle");

const addMemberSection = document.getElementById("addMemberSection");
const memberSearchInput = document.getElementById("memberSearchInput");
const memberSuggestions = document.getElementById("memberSuggestions");

let usersCache = [];
let isCurrentUserAdmin = false;

// --- Initialize ---
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUserId = user.uid;
    await loadRoomInfo();
    await preloadUsers();
    initMemberListeners();
    setupUI();
  }
});

// --- Load room info ---
async function loadRoomInfo() {
  const roomDoc = await getDoc(doc(db, "chatrooms", roomId));
  if (!roomDoc.exists()) {
    alert("Room does not exist.");
    window.location.href = "chatrooms.html";
    return;
  }
  const data = roomDoc.data();
  roomTitleEl.textContent = data.title || "Room Members";
}

// --- Preload users for member search ---
async function preloadUsers() {
  const usersSnap = await getDocs(collection(db, "users"));
  usersCache = [];
  usersSnap.forEach(u => usersCache.push({ id: u.id, ...u.data() }));
}

// --- Listen to members realtime ---
function initMemberListeners() {
  const membersRef = collection(db, "chatrooms", roomId, "members");
  const q = query(membersRef);

  onSnapshot(q, async (snapshot) => {
    membersData.clear();
    roomAdmins.clear();
    let usersToLoad = [];
    snapshot.forEach(docSnap => {
      const member = docSnap.data();
      const uid = docSnap.id;
      membersData.set(uid, { ...member, id: uid });
      if (member.role === "admin") roomAdmins.add(uid);
      usersToLoad.push(uid);
    });
    isCurrentUserAdmin = roomAdmins.has(currentUserId);
    addMemberSection.style.display = isCurrentUserAdmin ? "block" : "none";

    // Load user profiles for members
    await loadMemberUserProfiles(usersToLoad);
    renderMembers();
  });
}

async function loadMemberUserProfiles(userIds) {
  // For simplicity, use usersCache, but could get fresh docs if wanted
  // Just filter usersCache for matching ids
  // Will enhance membersData with user info for UI
  membersData.forEach((member, uid) => {
    const userInfo = usersCache.find(u => u.id === uid);
    if (userInfo) {
      member.displayName = userInfo.displayName || userInfo.email || "Unknown";
      member.photoUrl = userInfo.photoUrl || "";
    }
  });
}

// --- Render members list ---
function renderMembers() {
  membersList.innerHTML = "";
  membersData.forEach((member, uid) => {
    const div = document.createElement("div");
    div.className = "member-item" + (member.role === "admin" ? " admin" : "");
    if (isCurrentUserAdmin && member.role !== "admin") div.classList.add("can-remove");

    div.innerHTML = `
      <div class="member-info">
        <div class="member-avatar">${getInitials(member.displayName)}</div>
        <div class="member-name" title="${member.displayName}">${member.displayName}</div>
      </div>
      <div>
        <span class="role-badge ${member.role === "admin" ? "admin" : "member"}">${member.role}</span>
        ${isCurrentUserAdmin && member.role !== "admin" ? `<button class="remove-member-btn" title="Remove member">×</button>` : ""}
      </div>
    `;
    if (isCurrentUserAdmin && member.role !== "admin") {
      div.querySelector(".remove-member-btn").addEventListener("click", () => attemptRemoveMember(uid));
    }
    membersList.appendChild(div);
  });
}

// --- Helpers ---
function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts + parts[1]).toUpperCase();
}

// --- Remove member action ---
async function attemptRemoveMember(uid) {
  if (!isCurrentUserAdmin) return alert("Only admins can remove members.");
  if (!membersData.has(uid)) return;

  // Prevent removing last admin
  if (membersData.get(uid).role === "admin" && roomAdmins.size <= 1) {
    return alert("Cannot remove the last admin.");
  }

  const confirmRemove = confirm(`Remove ${membersData.get(uid).displayName} from the room?`);
  if (!confirmRemove) return;

  try {
    await deleteDoc(doc(db, "chatrooms", roomId, "members", uid));
  } catch (err) {
    alert("Failed to remove member. Please try again.");
    console.error("Remove member error:", err);
  }
}

// --- Add member UI & logic ---
// Search users on input (reusing preloaded usersCache)
memberSearchInput.addEventListener("input", () => {
  const text = memberSearchInput.value.toLowerCase().trim();
  if (!text) {
    memberSuggestions.style.display = "none";
    memberSuggestions.innerHTML = "";
    return;
  }
  const filtered = usersCache.filter(u =>
    (u.displayName && u.displayName.toLowerCase().includes(text)) ||
    (u.email && u.email.toLowerCase().includes(text))
  ).filter(u => !membersData.has(u.id)); // exclude existing members

  showMemberSuggestions(filtered.slice(0, 5));
});

function showMemberSuggestions(users) {
  memberSuggestions.innerHTML = "";
  if (users.length === 0) {
    memberSuggestions.style.display = "none";
    return;
  }
  users.forEach(user => {
    const div = document.createElement("div");
    div.textContent = user.displayName || user.email || "Unknown";
    div.title = user.email || "";
    div.style.cursor = "pointer";
    div.onclick = () => addMember(user);
    memberSuggestions.appendChild(div);
  });
  memberSuggestions.style.display = "block";
}

async function addMember(user) {
  memberSuggestions.style.display = "none";
  memberSearchInput.value = "";
  if (membersData.has(user.id)) return alert("User is already a member.");

  if (!isCurrentUserAdmin) return alert("Only admins can add members.");

  try {
    await setDoc(doc(db, "chatrooms", roomId, "members", user.id), {
      role: "member",
      joinedAt: serverTimestamp()
    });
  } catch (err) {
    alert("Failed to add member; try again.");
    console.error("Add member error:", err);
  }
}

// --- Navigation ---
backBtn.addEventListener("click", () => {
  window.location.href = "chatrooms.html";
});
