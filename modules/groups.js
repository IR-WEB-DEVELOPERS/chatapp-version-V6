// ============================================================
//  groups.js — Group creation, member management, leave
// ============================================================

async function loadFriendsForGroup() {
    const select = document.getElementById('groupMembers');
    if (!select) return;

    try {
        const friends      = currentUserData.friends || [];
        select.innerHTML   = '<option value="">Select friends...</option>';

        for (const friendUID of friends) {
            const friendData = await getUserData(friendUID);
            if (friendData) {
                const option      = document.createElement('option');
                option.value      = friendUID;
                option.textContent = friendData.name;
                select.appendChild(option);
            }
        }
    } catch (error) {
        console.error('Error loading friends for group:', error);
    }
}

async function createGroup() {
    const nameInput     = document.getElementById('groupName');
    const membersSelect = document.getElementById('groupMembers');
    if (!nameInput || !membersSelect) return;

    const name            = nameInput.value.trim();
    const selectedMembers = Array.from(membersSelect.selectedOptions).map(o => o.value).filter(Boolean);

    if (!name) {
        modalManager.showModal('Error', 'Please enter a group name', 'error');
        return;
    }
    if (selectedMembers.length === 0) {
        modalManager.showModal('Error', 'Please select at least one friend', 'error');
        return;
    }

    try {
        const groupId   = `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const allMembers = [currentUser.uid, ...selectedMembers];

        await db.collection('groups').doc(groupId).set({
            name,
            createdBy: currentUser.uid,
            members:   allMembers,
            createdAt: new Date(),
            admin:     currentUser.uid
        });

        nameInput.value           = '';
        membersSelect.selectedIndex = -1;
        modalManager.showModal('Success', 'Group created successfully!', 'success');
        loadGroupsList();
    } catch (error) {
        console.error('Error creating group:', error);
        modalManager.showModal('Error', 'Failed to create group', 'error');
    }
}

// BUG FIX 6: loadGroupsList used a one-time .get() so the groups list never
// updated when a new group was created, when the user was added to a group by
// someone else, or when they left — a page reload was required every time.
// Replaced with onSnapshot for live updates.
let _unsubGroupsList = null;

function loadGroupsList() {
    const groupsDiv = document.getElementById('groupsList');
    if (!groupsDiv) return;

    // Cancel previous listener to avoid duplicates
    if (_unsubGroupsList) { _unsubGroupsList(); _unsubGroupsList = null; }

    _unsubGroupsList = db.collection('groups')
        .where('members', 'array-contains', currentUser.uid)
        .onSnapshot(snapshot => {
            const countBadge = document.getElementById('groupsCount');
            if (countBadge) countBadge.textContent = snapshot.size;

            if (snapshot.empty) {
                groupsDiv.innerHTML = '<div class="no-groups">No groups yet. Create one above!</div>';
                return;
            }

            // Preserve active group highlight across re-renders
            const activeId = groupsDiv.querySelector('.group-item.active')?.dataset.groupid;

            let html = '';
            snapshot.forEach(doc => {
                const group       = doc.data();
                const memberCount = Array.isArray(group.members) ? group.members.length : 0;
                const isActive    = doc.id === activeId ? ' active' : '';
                html += `
                    <button class="group-item${isActive}" data-groupid="${escapeAttribute(doc.id)}">
                        <div class="group-avatar-icon">${escapeHTML((group.name || 'G')[0].toUpperCase())}</div>
                        <div class="group-info">
                            <h4>${escapeHTML(group.name)}</h4>
                            <p>${window.Icons ? window.Icons.get('users', 12) : ''} ${memberCount} member${memberCount !== 1 ? 's' : ''}</p>
                        </div>
                    </button>
                `;
            });

            groupsDiv.innerHTML = html;
            groupsDiv.querySelectorAll('.group-item').forEach(item => {
                item.addEventListener('click', () => {
                    groupsDiv.querySelectorAll('.group-item').forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                    openGroupChat(item.dataset.groupid);
                });
            });
        }, error => {
            console.error('Error loading groups:', error);
            groupsDiv.innerHTML = '<div class="no-groups">Error loading groups</div>';
        });
}

async function openGroupChat(groupId) {
    groupChatID   = groupId;
    chatWithUID   = null;

    if (unsubscribeDirectMessages) {
        unsubscribeDirectMessages();
        unsubscribeDirectMessages = null;
    }

    const defaultChat       = document.getElementById('defaultChat');
    const individualChat    = document.getElementById('individualChat');
    const groupChatContainer = document.getElementById('groupChatContainer');

    if (defaultChat)        defaultChat.style.display        = 'none';
    if (individualChat)     individualChat.style.display     = 'none';
    if (groupChatContainer) groupChatContainer.style.display = 'flex';
    const aiChatPane = document.getElementById('aiChatPane');
    if (aiChatPane)         aiChatPane.style.display         = 'none';

    if (window._hideSidebarOnMobile) window._hideSidebarOnMobile(); // triggers pushState for back button

    // Cache the group doc to avoid re-reads in add-member modal
    let group = enhancedCache.get(`group_${groupId}`);
    if (!group) {
        const groupDoc = await db.collection('groups').doc(groupId).get();
        if (!groupDoc.exists) return;
        group = groupDoc.data();
        enhancedCache.set(`group_${groupId}`, group, 5 * 60 * 1000);
    }
    if (group) {
        const groupChatName      = document.getElementById('groupChatName');
        const membersCount       = document.querySelector('.members-count');
        const groupPartnerAvatar = document.getElementById('groupPartnerAvatar');

        if (groupChatName) groupChatName.textContent = group.name;
        if (membersCount)  membersCount.textContent  = `${group.members.length} members`;

        if (groupPartnerAvatar) {
            const photoURL = group.photoURL || '';
            const initials = (group.name?.charAt(0)?.toUpperCase()) || 'G';
            if (photoURL) {
                groupPartnerAvatar.innerHTML = `<img class="avatar-img" src="${escapeAttribute(photoURL)}" alt="${escapeAttribute(initials)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span class="avatar-fallback" style="display:none;">${escapeHTML(initials)}</span>`;
            } else {
                groupPartnerAvatar.innerHTML = `<span class="avatar-fallback">${escapeHTML(initials)}</span>`;
            }
        }
    }

    loadGroupMessages();
    addCallButtonsToChat();
}

// ── Add member modal ─────────────────────────────────────────
async function openAddMemberModal() {
    if (!groupChatID) return;

    const modal   = document.getElementById('addMemberModal');
    const listDiv = document.getElementById('addMemberFriendsList');
    if (!modal || !listDiv) return;

    listDiv.innerHTML = '<div class="loading">Loading friends...</div>';
    modal.style.display = 'flex';

    try {
        // Use group cache
        let currentMembers = [];
        const groupCached = enhancedCache.get(`group_${groupChatID}`);
        if (groupCached) {
            currentMembers = groupCached.members || [];
        } else {
            const groupDoc = await db.collection('groups').doc(groupChatID).get();
            currentMembers = groupDoc.exists ? (groupDoc.data().members || []) : [];
            if (groupDoc.exists) enhancedCache.set(`group_${groupChatID}`, groupDoc.data(), 5 * 60 * 1000);
        }

        // Use in-memory currentUserData
        const friendUIDs = currentUserData?.friends || [];

        if (friendUIDs.length === 0) {
            listDiv.innerHTML = '<div style="padding:16px;text-align:center;color:#718096;">No friends to add</div>';
            return;
        }

        // Batch read uncached friends only
        const uncached = friendUIDs.filter(uid => !enhancedCache.get(`user_${uid}`));
        if (uncached.length > 0) {
            const chunks = [];
            for (let i = 0; i < uncached.length; i += 10) chunks.push(uncached.slice(i, i + 10));
            await Promise.all(chunks.map(async chunk => {
                try {
                    const snap = await db.collection('users')
                        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
                    snap.forEach(doc => enhancedCache.set(`user_${doc.id}`, doc.data(), 30 * 60 * 1000));
                } catch (e) {}
            }));
        }

        let html = '';
        friendUIDs.forEach((uid) => {
            const friend = enhancedCache.get(`user_${uid}`);
            if (!friend) return;
            const alreadyMember = currentMembers.includes(uid);

            html += `
                <div class="add-friend-select-item ${alreadyMember ? 'already-member' : ''}">
                    <div class="add-friend-avatar">${(friend.name || 'U')[0].toUpperCase()}</div>
                    <span class="add-friend-name">${escapeHTML(friend.name || 'User')}</span>
                    ${alreadyMember
                        ? '<span class="already-member-tag">Already in group</span>'
                        : `<input type="checkbox" class="add-friend-checkbox" data-uid="${escapeAttribute(uid)}" data-name="${escapeAttribute(friend.name || 'User')}">`
                    }
                </div>
            `;
        });

        listDiv.innerHTML = html || '<div style="padding:16px;text-align:center;color:#718096;">No friends available</div>';

        listDiv.querySelectorAll('.add-friend-select-item:not(.already-member)').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                const cb = item.querySelector('.add-friend-checkbox');
                if (cb) cb.checked = !cb.checked;
            });
        });

    } catch (error) {
        console.error('Error loading friends for add member:', error);
        listDiv.innerHTML = '<div style="padding:16px;text-align:center;color:#e53e3e;">Error loading friends</div>';
    }
}

async function confirmAddMembers() {
    if (!groupChatID) return;

    const checkboxes = document.querySelectorAll('#addMemberFriendsList .add-friend-checkbox:checked');
    if (checkboxes.length === 0) {
        modalManager.showModal('Notice', 'Please select at least one friend to add', 'info');
        return;
    }

    const selectedUIDs  = Array.from(checkboxes).map(cb => cb.dataset.uid);
    const selectedNames = Array.from(checkboxes).map(cb => cb.dataset.name);

    try {
        const groupRef       = db.collection('groups').doc(groupChatID);
        const groupDoc       = await groupRef.get();
        const currentMembers = groupDoc.exists ? (groupDoc.data().members || []) : [];
        const newMembers     = [...new Set([...currentMembers, ...selectedUIDs])];

        await groupRef.update({ members: newMembers });

        await db.collection('groupMessages').add({
            groupId:    groupChatID, sender: 'system', senderName: 'System',
            text:       `${selectedNames.join(', ')} added to the group`,
            time:       new Date(), type: 'system'
        });

        document.getElementById('addMemberModal').style.display = 'none';

        const membersCount = document.querySelector('.members-count');
        if (membersCount) membersCount.textContent = `${newMembers.length} members`;

        modalManager.showModal('Success', `${selectedNames.join(', ')} added to group!`, 'success');
    } catch (error) {
        console.error('Error adding members:', error);
        modalManager.showModal('Error', 'Failed to add members', 'error');
    }
}

// ── Leave group ──────────────────────────────────────────────
async function openLeaveGroupModal() {
    if (!groupChatID) return;
    const modal   = document.getElementById('leaveGroupModal');
    const nameEl  = document.getElementById('leaveGroupName');
    if (!modal) return;
    const groupChatName = document.getElementById('groupChatName');
    if (nameEl && groupChatName) nameEl.textContent = groupChatName.textContent;
    modal.style.display = 'flex';
}

async function confirmLeaveGroup() {
    if (!groupChatID) return;

    try {
        const groupRef   = db.collection('groups').doc(groupChatID);
        const groupDoc   = await groupRef.get();
        if (!groupDoc.exists) return;

        const group          = groupDoc.data();
        const updatedMembers = (group.members || []).filter(uid => uid !== currentUser.uid);

        if (updatedMembers.length === 0) {
            await groupRef.delete();
        } else {
            await groupRef.update({ members: updatedMembers });
            await db.collection('groupMessages').add({
                groupId:    groupChatID, sender: 'system', senderName: 'System',
                text:       `${currentUserData?.name || 'User'} left the group`,
                time:       new Date(), type: 'system'
            });
        }

        document.getElementById('leaveGroupModal').style.display = 'none';

        groupChatID = null;
        if (unsubscribeGroupMessages) {
            unsubscribeGroupMessages();
            unsubscribeGroupMessages = null;
        }

        document.getElementById('groupChatContainer').style.display = 'none';
        document.getElementById('defaultChat').style.display        = 'flex';

        loadGroupsList();
    } catch (error) {
        console.error('Error leaving group:', error);
        modalManager.showModal('Error', 'Failed to leave group', 'error');
    }
}

// ── Expose ───────────────────────────────────────────────────
window.loadFriendsForGroup  = loadFriendsForGroup;
window.createGroup          = createGroup;
window.loadGroupsList       = loadGroupsList;
window.openGroupChat        = openGroupChat;
window.openAddMemberModal   = openAddMemberModal;
window.confirmAddMembers    = confirmAddMembers;
window.openLeaveGroupModal  = openLeaveGroupModal;
window.confirmLeaveGroup    = confirmLeaveGroup;

console.log('groups.js loaded');
