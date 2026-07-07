/**
 * Live Studio Booking Management System - Frontend Logic
 * File: app.js
 */

let GAS_API_URL = localStorage.getItem('gas_api_url') || "https://script.google.com/macros/s/AKfycbyUm0c2LCXIS9b76TsTmD7mWVzAuILkGa4HJUbHfoUDBBRflfVXAV26TBSgUYAFoqtX/exec";

// State Management
let state = {
  currentUser: null,      // { email, name, role, status }
  authToken: null,        // JWT Token string
  rooms: [],              // Array of active rooms
  brands: [],             // Array of active brands
  bookings: [],           // Array of bookings for selectedDate
  todayBookings: null,    // Array of bookings for today's date
  selectedDate: getFormattedDate(new Date()), // YYYY-MM-DD
  currentTab: 'my-bookings',
  myBookings: [],
  auditLogs: [],
  auditLogsUnlocked: false,
  auditLogsPassword: "",
  schedulerSearch: "",
  myBookingsSortOrder: 'desc',
  auditLogsSortOrder: 'desc',
  allRoomsAdmin: [],      // Includes inactive rooms for Admin Panel
  allBrandsAdmin: [],     // Includes inactive brands for Admin Panel
  allUsersAdmin: [],      // Users list for Admin Panel
  isMockMode: false,
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
  calendarViewMode: 'month',
  calendarSelectedDate: new Date(),
  calendarBookings: [],
  filters: { room: '', brand: '', status: '', action: 'all' },
  campaignSchedulePage: 1,
  campaignSchedulePageSize: parseInt(localStorage.getItem('campaign_schedule_page_size')) || 10,
  analyticsStartDate: '',
  analyticsEndDate: '',
  // Track which tabs have already fetched data (prevents re-fetch on every tab switch)
  tabLoaded: {}
};

// Scheduler grid configurations
const SCHEDULER_START_HOUR = 0;  // 00:00
const SCHEDULER_END_HOUR = 24;   // 24:00
const CELL_WIDTH_PX = 80;        // Width of a 30-min block
const CELL_DURATION_MINS = 30;   // 30-minute intervals

// Polling interval (30 seconds)
let pollingTimer = null;

function hasTabPermission(tabId) {
  if (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.allowedTabs) {
    const allowed = state.currentUser.permissions.allowedTabs.split(',');
    return allowed.includes(tabId);
  }
  const role = getUserRole();
  if (role === 'master admin') return true;
  if (role === 'admin') return tabId === 'campaign-schedule';
  return ['my-bookings', 'calendar', 'analytics'].includes(tabId);
}

function detectAndNotifyNewBookings(oldArray, newArray) {
  if (!oldArray || oldArray.length === 0 || !newArray || newArray.length === 0) return;
  const oldIds = new Set(oldArray.map(b => b.id));
  
  newArray.forEach(nb => {
    if (!oldIds.has(nb.id) && !nb.isOptimistic && nb.status !== 'Cancelled') {
      const isMyBooking = state.currentUser && nb.ownerEmail && (nb.ownerEmail.toLowerCase() === state.currentUser.email.toLowerCase());
      if (!isMyBooking) {
        const ownerLabel = nb.ownerName || 'ผู้ใช้ท่านอื่น';
        showToast(`🔔 คุณ ${ownerLabel} ได้ทำรายการจองห้อง ${nb.roomName} (${nb.startTime} - ${nb.endTime} น.)`, 'info');
      }
    }
  });
}

function mergeServerBookings(localArray, serverArray) {
  if (!localArray) return serverArray || [];
  if (!serverArray) return localArray;
  const merged = [];
  serverArray.forEach(sb => {
    // Try to find matching local booking by exact ID
    let lb = localArray.find(x => x.id === sb.id);
    
    // Fallback match: if sb has a real ID but lb is optimistic with a TEMP ID, match by date, roomName, startTime, and brandName
    if (!lb) {
      lb = localArray.find(x => 
        x.isOptimistic && 
        x.date === sb.date && 
        x.roomName === sb.roomName && 
        x.startTime === sb.startTime &&
        x.brandName === sb.brandName
      );
    }
    
    if (lb && lb.isOptimistic) {
      lb.id = sb.id; // Promote optimistic booking ID in place so it is not caught as orphan
      delete lb.isOptimistic; // It is now confirmed by server
      merged.push(sb); // Keep server version as source of truth
    } else {
      merged.push(sb);
    }
  });
  const serverIds = new Set(serverArray.map(b => b.id));
  localArray.forEach(lb => {
    if (lb.isOptimistic && !serverIds.has(lb.id)) {
      merged.push(lb);
    }
  });
  return merged;
}

// Initialize Page
window.addEventListener('DOMContentLoaded', () => {
  // Check if we already have an API URL, if not prompt or run in mock mode
  if (!GAS_API_URL) {
    state.isMockMode = true;
    console.warn("GAS_API_URL is empty. Running in Browser Mock Mode.");
    initializeMockData();
  }

  // Initialize Dark Mode theme preference
  initDarkMode();

  // Load Lucide Icons
  lucide.createIcons();
  
  // Render Mock UI Settings Button (Floating Gear to change GAS URL)
  createUrlSettingsButton();
  
  // Populate time dropdowns in booking modal
  populateTimeDropdowns();

  // Bind conflict checks on booking form inputs
  ['booking-form-room', 'booking-form-date', 'booking-form-start-time', 'booking-form-end-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', checkBookingConflict);
  });

  // Check if user has active session cached
  checkCachedSession();
});

/**
 * Helper to get the lowercase role of the current user
 */
function getUserRole() {
  if (!state.currentUser || !state.currentUser.role) return '';
  const r = String(state.currentUser.role).trim().toLowerCase();
  if (r === 'master admin' || r === 'ผู้ดูแลระบบสูงสุด') return 'master admin';
  if (r === 'admin' || r === 'แอดมิน' || r === 'หัวหน้าแอดมิน' || r === 'head admin') return 'admin';
  return r;
}

/**
 * Check if session is cached in localStorage
 */
function checkCachedSession() {
  const cachedToken = localStorage.getItem('auth_token');
  const cachedUser = localStorage.getItem('auth_user');
  
  if (cachedToken && cachedUser) {
    // Automatically restore mock mode state from token signature
    if (cachedToken.includes(':mock_token_')) {
      state.isMockMode = true;
    } else {
      state.isMockMode = false;
    }
    
    state.authToken = cachedToken;
    state.currentUser = JSON.parse(cachedUser);
    
    // Restore static rooms & brands from localStorage immediately
    try {
      const cachedRooms = localStorage.getItem('cached_rooms');
      const cachedBrands = localStorage.getItem('cached_brands');
      if (cachedRooms) state.rooms = JSON.parse(cachedRooms);
      if (cachedBrands) state.brands = JSON.parse(cachedBrands);
      
      const cachedCalendarStr = localStorage.getItem('cached_calendar_bookings');
      if (cachedCalendarStr) state.calendarBookings = JSON.parse(cachedCalendarStr);
    } catch (e) {
      console.error("Error restoring cached rooms/brands/calendarBookings:", e);
    }

    if (state.rooms && state.rooms.length > 0) {
      populateFilterDropdowns();
    }

    // Restore admin lists from localStorage immediately
    try {
      const cachedAllRooms = localStorage.getItem('cached_all_rooms_admin');
      const cachedAllBrands = localStorage.getItem('cached_all_brands_admin');
      const cachedAllUsers = localStorage.getItem('cached_all_users_admin');
      if (cachedAllRooms) {
        state.allRoomsAdmin = JSON.parse(cachedAllRooms);
        state.tabLoaded['rooms'] = true;
      }
      if (cachedAllBrands) {
        state.allBrandsAdmin = JSON.parse(cachedAllBrands);
        state.tabLoaded['brands'] = true;
      }
      if (cachedAllUsers) {
        state.allUsersAdmin = JSON.parse(cachedAllUsers);
        state.tabLoaded['users'] = true;
      }
    } catch (e) {
      console.error("Error restoring cached admin data:", e);
    }

    // Auto-login
    showAppShell();

    // Trigger instant scheduler load from local cache if we have it
    if (state.rooms && state.rooms.length > 0) {
      fetchBookings(state.selectedDate, true);
    }
    fetchTodayBookings(true);

    fetchInitData();
    startPolling();
  } else {
    // Show login page
    document.getElementById('login-page').classList.remove('hidden');
    document.getElementById('app-shell').classList.add('hidden');
  }
}

/**
 * Create a UI helper to configure the Google App Script URL
 */
function createUrlSettingsButton() {
  const btn = document.createElement('button');
  btn.className = "fixed bottom-6 left-6 z-[49] w-10 h-10 bg-slate-800 hover:bg-slate-700 text-white rounded-full flex items-center justify-center shadow-lg transition-all border border-slate-700";
  btn.innerHTML = `<i data-lucide="settings" class="w-5 h-5"></i>`;
  btn.onclick = () => {
    const currentUrl = localStorage.getItem('gas_api_url') || "";
    const newUrl = prompt("กรอก URL ของ Google App Script Web App (ถ้าปล่อยว่างจะใช้งานแบบจำลอง Mock Mode บนเครื่องนี้):", currentUrl);
    if (newUrl !== null) {
      localStorage.setItem('gas_api_url', newUrl.trim());
      location.reload();
    }
  };
  document.body.appendChild(btn);
  lucide.createIcons();
  
  // Render Mock Mode Banner if running Mock Mode
  if (state.isMockMode) {
    const banner = document.createElement('div');
    banner.className = "bg-amber-500 text-white text-center py-1 px-4 text-xs font-semibold select-none flex items-center justify-center gap-2 relative z-50";
    banner.innerHTML = `
      <span>⚠️ กำลังรันในโหมดจำลอง (Mock Mode) บนเครื่องของคุณ ข้อมูลถูกบันทึกใน Browser เท่านั้น</span>
      <button onclick="localStorage.setItem('gas_api_url', prompt('กรอก App Script URL:') || ''); location.reload();" class="underline ml-2 bg-amber-600 px-2 py-0.5 rounded hover:bg-amber-700 transition-all">เชื่อมต่อ Google Sheets</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
  }
}

/**
 * Handle Custom Username / Password Login
 */
function handleCustomLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const connectReal = document.getElementById('mock-connect-real-gas')?.checked;
  
  if (!email || !password) {
    showToast("กรุณากรอกชื่อผู้ใช้และรหัสผ่าน", "error");
    return;
  }
  
  const submitBtn = document.getElementById('login-submit-btn');
  const origHtml = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span class="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></span> กำลังเข้าสู่ระบบ...`;
  
  if (!connectReal) {
    state.isMockMode = true;
  } else {
    state.isMockMode = false;
  }
  
  if (state.isMockMode) {
    setTimeout(() => {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origHtml;
      
      let mockUsers = JSON.parse(localStorage.getItem('mock_db_users') || '[]');
      let adminUser = mockUsers.find(u => u.email.toLowerCase() === "admin");
      if (!adminUser || adminUser.password !== "admin1234" || String(adminUser.role).toLowerCase() !== "admin") {
        mockUsers = mockUsers.filter(u => u.email.toLowerCase() !== "admin");
        mockUsers.push({ email: "admin", name: "System Admin (Admin)", role: "Admin", status: "Active", password: "admin1234" });
        localStorage.setItem('mock_db_users', JSON.stringify(mockUsers));
      }
      let masterAdminUser = mockUsers.find(u => u.email.toLowerCase() === "masteradmin");
      if (!masterAdminUser) {
        mockUsers.push({ email: "masteradmin", name: "Master Admin", role: "Master Admin", status: "Active", password: "Admin@1234" });
        localStorage.setItem('mock_db_users', JSON.stringify(mockUsers));
      }
      
      const user = mockUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
      if (!user) {
        showToast("ไม่พบบัญชีผู้ใช้งานนี้ในระบบจำลอง", "error");
        return;
      }
      if (user.password !== password) {
        showToast("รหัสผ่านไม่ถูกต้อง", "error");
        return;
      }
      
      const token = email + ":mock_token_" + new Date().getTime();
      state.authToken = token;
      state.currentUser = user;
      state.tabLoaded = {}; // Reset tab loading flags to prevent session state leakage
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', JSON.stringify(user));
      
      showToast(`ยินดีต้อนรับคุณ ${user.name}! (โหมดจำลอง)`, "success");
      showAppShell();
      initializeMockData();
      fetchInitData();
      startPolling();
    }, 800);
  } else {
    const payload = {
      action: "login",
      email: email,
      password: password
    };
    
    fetch(GAS_API_URL, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origHtml;
      
      if (data.success) {
        state.authToken = data.token;
        state.currentUser = data.user;
        state.tabLoaded = {}; // Reset tab loading flags to prevent session state leakage
        localStorage.setItem('auth_token', data.token);
        localStorage.setItem('auth_user', JSON.stringify(data.user));
        
        showToast(`เข้าสู่ระบบสำเร็จ ยินดีต้อนรับคุณ ${data.user.name}`, "success");
        showAppShell();
        fetchInitData();
        startPolling();
      } else {
        showToast(data.message || "การเข้าสู่ระบบล้มเหลว", "error");
      }
    })
    .catch(err => {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origHtml;
      showToast(`เชื่อมต่อเซิร์ฟเวอร์หลังบ้านล้มเหลว: ${err.message}`, "error");
    });
  }
}

/**
 * Handle Logout
 */
function handleLogout() {
  // Clear Auth state
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_user');
  state.authToken = null;
  state.currentUser = null;
  
  // Clear active tab state & restore default
  state.currentTab = 'my-bookings';
  state.tabLoaded = {};
  state.calendarBookings = [];
  state.myBookings = [];
  state.rooms = [];
  state.brands = [];
  state.allRoomsAdmin = [];
  state.allBrandsAdmin = [];
  state.allUsersAdmin = [];
  
  // Clear cached application data
  localStorage.removeItem('cached_rooms');
  localStorage.removeItem('cached_brands');
  localStorage.removeItem('cached_calendar_bookings');
  localStorage.removeItem('cached_my_bookings');
  localStorage.removeItem('cached_all_rooms_admin');
  localStorage.removeItem('cached_all_brands_admin');
  localStorage.removeItem('cached_all_users_admin');
  
  stopPolling();
  
  // Reset navigation selection UI in sidebar to default
  document.querySelectorAll('aside nav button').forEach(btn => {
    btn.classList.remove('bg-brand-50', 'text-brand-700', 'dark:bg-brand-900/20', 'dark:text-brand-400');
    btn.classList.add('text-slate-600', 'dark:text-slate-400', 'hover:bg-slate-50', 'dark:hover:bg-slate-800/50');
  });
  const defaultBtn = document.getElementById('tab-btn-my-bookings');
  if (defaultBtn) {
    defaultBtn.classList.remove('text-slate-600', 'dark:text-slate-400', 'hover:bg-slate-50', 'dark:hover:bg-slate-800/50');
    defaultBtn.classList.add('bg-brand-50', 'text-brand-700', 'dark:bg-brand-900/20', 'dark:text-brand-400');
  }
  
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

/**
 * Show the core application shell UI
 */
function showAppShell() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  
  // Set User Profile UI info
  document.getElementById('user-display-name').innerText = state.currentUser.name;
  document.getElementById('user-display-role').innerText = state.currentUser.role;
  document.getElementById('user-display-email').innerText = state.currentUser.email;
  
  // Avatar
  const nameParts = state.currentUser.name.split(' ');
  const initials = nameParts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
  document.getElementById('user-avatar-container').innerText = initials;
  
  // Apply sidebar/permission visibility using the dedicated function
  applySidebarPermissions();

  
  // Setup date picker default value
  document.getElementById('scheduler-date-picker').value = state.selectedDate;
  
  // Initialize campaign-schedule dates
  const startInput = document.getElementById('campaign-schedule-start-date');
  const endInput = document.getElementById('campaign-schedule-end-date');
  if (startInput && !startInput.value) {
    startInput.value = state.selectedDate;
  }
  if (endInput && !endInput.value) {
    endInput.value = state.selectedDate;
  }

  // Initialize my-bookings date filter to default (Today)
  const myBookingsStartDate = document.getElementById('my-bookings-filter-start-date');
  const myBookingsEndDate = document.getElementById('my-bookings-filter-end-date');
  if (myBookingsStartDate && !myBookingsStartDate.value) {
    myBookingsStartDate.value = state.selectedDate;
  }
  if (myBookingsEndDate && !myBookingsEndDate.value) {
    myBookingsEndDate.value = state.selectedDate;
  }
  const myBookingsSearch = document.getElementById('my-bookings-search');
  if (myBookingsSearch) {
    myBookingsSearch.value = "";
  }
  
  lucide.createIcons();
  switchTab(state.currentTab);
}

/**
 * Generate skeleton table rows that visually match a table's real column structure.
 * @param {number} count - number of skeleton rows to render
 * @param {Array<{w: string}>} cols - column width definitions e.g. [{w:'20%'},{w:'40%'}]
 * @returns {string} HTML string of <tr> skeleton rows
 */
function skTableRows(count, cols) {
  return Array.from({ length: count }, (_, rowIdx) => {
    const cells = cols.map(col => `
      <td style="padding:14px 16px">
        <div class="sk-cell" style="width:${col.w};animation-delay:${rowIdx * 0.08}s"></div>
      </td>`).join('');
    return `<tr style="border-bottom:1px solid #f1f5f9">${cells}</tr>`;
  }).join('');
}


/**
 * Apply sidebar menu visibility based on the current user's role and permissions.
 *
 * This is intentionally separated from showAppShell() so it can be called again
 * after fetchInitData() resolves with fresh user data that contains the full
 * `permissions` object — fixing the 5-10s race condition where the sidebar
 * briefly showed incorrect menus from the stale localStorage-cached user.
 */
function applySidebarPermissions() {
  if (!state.currentUser) return;

  const adminElements = document.querySelectorAll('.admin-only');
  const writeElements = document.querySelectorAll('.write-only');
  const masterAdminElements = document.querySelectorAll('.master-admin-only');

  const myBookingsBtn = document.getElementById('tab-btn-my-bookings');
  const calendarBtn = document.getElementById('tab-btn-calendar');
  const analyticsBtn = document.getElementById('tab-btn-analytics');
  const insightsGroup = document.getElementById('sidebar-group-insights');

  // Reset standard tabs to visible before applying permission filter
  if (myBookingsBtn) myBookingsBtn.classList.remove('hidden');
  if (calendarBtn) calendarBtn.classList.remove('hidden');
  if (analyticsBtn) analyticsBtn.classList.remove('hidden');
  if (insightsGroup) insightsGroup.classList.remove('hidden');

  if (state.currentUser.permissions && state.currentUser.permissions.allowedTabs) {
    const allowed = state.currentUser.permissions.allowedTabs.split(',').map(t => t.trim().toLowerCase());

    const tabMap = {
      'my-bookings':       document.getElementById('tab-btn-my-bookings'),
      'calendar':          document.getElementById('tab-btn-calendar'),
      'campaign-schedule': document.getElementById('tab-btn-campaign-schedule'),
      'analytics':         document.getElementById('tab-btn-analytics'),
      'rooms':             document.getElementById('tab-btn-rooms'),
      'brands':            document.getElementById('tab-btn-brands'),
      'users':             document.getElementById('tab-btn-users'),
      'audit-log':         document.getElementById('tab-btn-audit-log'),
      'settings':          document.getElementById('tab-btn-settings'),
      'roles-mgmt':        document.getElementById('tab-btn-roles-mgmt')
    };

    for (let tId in tabMap) {
      const el = tabMap[tId];
      if (el) {
        if (allowed.includes(tId)) el.classList.remove('hidden');
        else                        el.classList.add('hidden');
      }
    }

    // Administration group
    const adminGroup = document.querySelector('.admin-only');
    if (adminGroup) {
      const adminTabs = ['rooms', 'brands', 'users', 'roles-mgmt', 'audit-log', 'settings'];
      const hasAnyAdminTab = adminTabs.some(t => allowed.includes(t));
      if (hasAnyAdminTab) adminGroup.classList.remove('hidden');
      else                adminGroup.classList.add('hidden');
    }

    if (insightsGroup) {
      if (allowed.includes('analytics')) insightsGroup.classList.remove('hidden');
      else                               insightsGroup.classList.add('hidden');
    }

    const canCreate = state.currentUser.permissions.canCreateBooking;
    const canEdit   = state.currentUser.permissions.canEditBooking;
    const canCancel = state.currentUser.permissions.canCancelBooking;
    const isAdmin   = state.currentUser.permissions.isAdmin;

    if (isAdmin) adminElements.forEach(el => el.classList.remove('hidden'));

    masterAdminElements.forEach(el => {
      if (el.id && el.id.startsWith('tab-btn-')) {
        const tabId = el.id.replace('tab-btn-', '');
        if (allowed.includes(tabId)) el.classList.remove('hidden');
        else                          el.classList.add('hidden');
      } else {
        if (isAdmin) el.classList.remove('hidden');
        else         el.classList.add('hidden');
      }
    });

    if (canCreate || canEdit || canCancel) {
      writeElements.forEach(el => el.classList.remove('hidden'));
    } else {
      writeElements.forEach(el => el.classList.add('hidden'));
    }

    // Redirect if current tab is not allowed
    if (!allowed.includes(state.currentTab)) {
      state.currentTab = allowed.includes('my-bookings') ? 'my-bookings' : allowed[0];
    }
  } else {
    // Legacy role-based fallback (no permissions object in user record)
    const userRole = getUserRole();
    if (userRole === 'master admin') {
      adminElements.forEach(el => el.classList.remove('hidden'));
      writeElements.forEach(el => el.classList.remove('hidden'));
      masterAdminElements.forEach(el => el.classList.remove('hidden'));
    } else if (userRole === 'admin') {
      if (myBookingsBtn) myBookingsBtn.classList.add('hidden');
      if (calendarBtn)   calendarBtn.classList.add('hidden');
      if (analyticsBtn)  analyticsBtn.classList.add('hidden');
      if (insightsGroup) insightsGroup.classList.add('hidden');
      adminElements.forEach(el => el.classList.add('hidden'));
      writeElements.forEach(el => el.classList.add('hidden'));
      masterAdminElements.forEach(el => {
        if (el.id === 'tab-btn-campaign-schedule') el.classList.remove('hidden');
        else                                        el.classList.add('hidden');
      });
      state.currentTab = 'campaign-schedule';
    } else if (userRole === 'campaign manager') {
      adminElements.forEach(el => el.classList.add('hidden'));
      writeElements.forEach(el => el.classList.remove('hidden'));
      masterAdminElements.forEach(el => el.classList.add('hidden'));
    } else {
      adminElements.forEach(el => el.classList.add('hidden'));
      writeElements.forEach(el => el.classList.add('hidden'));
      masterAdminElements.forEach(el => el.classList.add('hidden'));
    }
  }
}

function fetchInitData(isSilent = false) {
  apiCall('getInitData', {}, (err, data) => {
    if (err) {
      showToast("ไม่สามารถโหลดข้อมูลเริ่มต้นได้: " + err, "error");
      return;
    }
    if (data.user) {
      state.currentUser = data.user;
      try {
        localStorage.setItem('auth_user', JSON.stringify(data.user));
      } catch (e) {}
      // Re-apply sidebar permissions with the fresh, complete user object from the
      // server (which includes the full `permissions` object). This fixes the
      // 5-10s race condition where the sidebar showed wrong menus because the
      // cached localStorage user didn't have permissions yet.
      applySidebarPermissions();
      
      // Re-evaluate tab permissions and automatically redirect the user if they
      // do not have permission for the current tab (e.g. initial login fallback)
      switchTab(state.currentTab);
    }
    state.rooms = data.rooms;
    state.brands = data.brands;
    
    if (data.allBookings) {
      detectAndNotifyNewBookings(state.calendarBookings, data.allBookings);
      state.calendarBookings = mergeServerBookings(state.calendarBookings, data.allBookings);
      state.tabLoaded['calendar'] = true;
      state.tabLoaded['analytics'] = true;
      state.tabLoaded['campaign-schedule'] = true;
      
      // Sync myBookings locally from data.allBookings to make My Bookings render instantly
      if (state.currentUser && state.currentUser.email) {
        state.myBookings = state.calendarBookings.filter(b =>
          b.ownerEmail && b.ownerEmail.toLowerCase() === state.currentUser.email.toLowerCase()
        );
        state.tabLoaded['my-bookings'] = true;
        try {
          localStorage.setItem('cached_my_bookings', JSON.stringify(state.myBookings));
        } catch (e) {}
      }

      try {
        localStorage.setItem('cached_calendar_bookings', JSON.stringify(state.calendarBookings));
      } catch (e) {}
    }
    
    // Save to localStorage
    try {
      localStorage.setItem('cached_rooms', JSON.stringify(data.rooms));
      localStorage.setItem('cached_brands', JSON.stringify(data.brands));
    } catch (e) {
      console.error("Error writing rooms/brands to cache:", e);
    }
    
    // Admin structures loaded instantly from init data to avoid slow loading times
    if (data.allRoomsAdmin) {
      state.allRoomsAdmin = data.allRoomsAdmin;
      state.tabLoaded['rooms'] = true;
      try {
        localStorage.setItem('cached_all_rooms_admin', JSON.stringify(data.allRoomsAdmin));
      } catch (e) {}
    }
    if (data.allBrandsAdmin) {
      state.allBrandsAdmin = data.allBrandsAdmin;
      state.tabLoaded['brands'] = true;
      try {
        localStorage.setItem('cached_all_brands_admin', JSON.stringify(data.allBrandsAdmin));
      } catch (e) {}
    }
    if (data.allUsersAdmin) {
      state.allUsersAdmin = data.allUsersAdmin;
      state.tabLoaded['users'] = true;
      try {
        localStorage.setItem('cached_all_users_admin', JSON.stringify(data.allUsersAdmin));
      } catch (e) {}
    }
    
    // Populate select lists in booking modal
    populateBookingFormBrands();

    const roomSelect = document.getElementById('booking-form-room');
    if (roomSelect) {
      const oldRoom = roomSelect.value;
      roomSelect.innerHTML = `<option value="">-- เลือกห้องไลฟ์ --</option>`;
      state.rooms.forEach(r => {
        roomSelect.innerHTML += `<option value="${r.name}">${r.name} (${r.description})</option>`;
      });
      if (oldRoom) {
        roomSelect.value = oldRoom;
      }
    }

    // Populate filter dropdowns
    populateFilterDropdowns();

    // Load active tab first
    if (!isSilent) {
      refreshActiveTabData();
    } else {
      _rerenderTab(state.currentTab);
    }

    // Background prefetch all other tabs silently after a short delay
    // so they're ready instantly when the user clicks them
    if (!isSilent) {
      prefetchAllTabsInBackground();
    }
  });
}

/**
 * Silently prefetch data for all tabs in the background after login.
 * Uses staggered delays to avoid hammering the API at once.
 */
function prefetchAllTabsInBackground() {
  const currentTab = state.currentTab;

  // Queue: [tabId, delayMs]
  // Skip the active tab (already loading via refreshActiveTabData)
  const queue = [
    ['my-bookings',  800],
    ['calendar',    1600],
    ['analytics',   2400],
  ];

  // Admin tabs prefetching dynamically based on actual permissions
  if (state.currentUser) {
    if (hasTabPermission('rooms')) queue.push(['rooms', 3200]);
    if (hasTabPermission('brands')) queue.push(['brands', 4000]);
    if (hasTabPermission('users')) queue.push(['users', 4800]);
  }

  queue.forEach(([tabId, delay]) => {
    if (tabId === currentTab) return; // already loading
    setTimeout(() => {
      // Check current tab at fire time, not at capture time
      if (tabId === state.currentTab) return;

      const loadKey = tabId === 'scheduler' ? `scheduler_${state.selectedDate}` : tabId;
      if (state.tabLoaded[loadKey]) return;

      // Silently fetch data into state
      _prefetchTab(tabId);
    }, delay);
  });
}

/**
 * Silently fetch a tab's data into state without showing any UI feedback.
 */
function _prefetchTab(tabId) {
  if (tabId === 'my-bookings') {
    apiCall('getMyBookings', {}, (err, data) => {
      if (!err) {
        state.myBookings = mergeServerBookings(state.myBookings, data.bookings);
        state.tabLoaded['my-bookings'] = true; // Mark as loaded only on success
        try {
          localStorage.setItem('cached_my_bookings', JSON.stringify(state.myBookings));
        } catch (e) {
          console.error("Error caching prefetched my bookings:", e);
        }
      }
    });
  } else if (tabId === 'calendar' || tabId === 'analytics' || tabId === 'campaign-schedule') {
    // Both calendar, analytics, and campaign-schedule share state.calendarBookings
    if (state.calendarBookings && state.calendarBookings.length > 0) return;
    apiCall('getAllBookings', {}, (err, data) => {
      if (!err) {
        state.calendarBookings = mergeServerBookings(state.calendarBookings, data.bookings);
        // Pre-mark shared tabs as loaded too since they share data
        state.tabLoaded['analytics'] = true;
        state.tabLoaded['calendar'] = true;
        state.tabLoaded['campaign-schedule'] = true;
      }
    });
  } else if (tabId === 'rooms') {
    apiCall('manageRooms', { subAction: 'list' }, (err, data) => {
      if (!err) {
        state.allRoomsAdmin = data.rooms;
        state.tabLoaded['rooms'] = true;
      }
    });
  } else if (tabId === 'brands') {
    apiCall('manageBrands', { subAction: 'list' }, (err, data) => {
      if (!err) {
        state.allBrandsAdmin = data.brands;
        state.tabLoaded['brands'] = true;
      }
    });
  } else if (tabId === 'users') {
    apiCall('manageUsers', { subAction: 'list' }, (err, data) => {
      if (!err) {
        state.allUsersAdmin = data.users;
        state.tabLoaded['users'] = true;
      }
    });
  }
}


/**
 * Refresh current tab data
 */
/**
 * Invalidate one or more tab caches so next switchTab will re-fetch.
 * Call this after any write operation (create/update/cancel).
 * @param {...string} tabs - tab IDs to invalidate, e.g. 'scheduler','my-bookings'
 */
function invalidateTabCache(...tabs) {
  if (tabs.length === 0) {
    // Invalidate all tabs
    state.tabLoaded = {};
  } else {
    tabs.forEach(t => { delete state.tabLoaded[t]; });
  }
}

function refreshActiveTabData(isSilent = false) {
  if (isSilent) {
    fetchInitData(true);
  }
  // Refresh today's bookings in the background to update KPIs
  fetchTodayBookings(isSilent);

  const tab = state.currentTab;

  // When called silently (polling), always force-refresh
  // When called explicitly (e.g. after write), also force-refresh
  const forceRefresh = !isSilent; // non-silent means user-triggered, always refresh
  // But for polling (isSilent=true), still refresh to pick up changes
  // So in both cases we refresh — this function is only called when refresh IS needed.
  // The "no re-fetch on tab switch" logic is in switchTab() below.

  if (tab === 'scheduler') {
    fetchBookings(state.selectedDate, isSilent);
  } else if (tab === 'my-bookings') {
    fetchMyBookings(isSilent);
  } else if (tab === 'calendar') {
    loadCalendarView(isSilent);
  } else if (tab === 'analytics') {
    loadAnalyticsView(isSilent);
  } else if (tab === 'campaign-schedule') {
    loadCampaignScheduleView(isSilent);
  } else if (tab === 'rooms') {
    fetchRoomsAdmin(isSilent);
  } else if (tab === 'brands') {
    fetchBrandsAdmin(isSilent);
  } else if (tab === 'users') {
    fetchUsersAdmin(isSilent);
  } else if (tab === 'audit-log') {
    if (state.auditLogsUnlocked) {
      fetchAuditLogs(isSilent);
    }
  } else if (tab === 'settings') {
    loadSettingsTab(isSilent);
  } else if (tab === 'roles-mgmt') {
    fetchRolesAdmin(isSilent, true);
  }
}

/**
 * Fetch bookings for Scheduler Tab
 */
function fetchBookings(dateStr, isSilent = false) {
  // Check if we have localStorage cached bookings for this exact date
  let hasCache = false;
  try {
    const cachedDate = localStorage.getItem('cached_scheduler_date');
    const cachedBookingsStr = localStorage.getItem('cached_scheduler_bookings');
    
    if (cachedDate === dateStr && cachedBookingsStr) {
      state.bookings = JSON.parse(cachedBookingsStr);
      renderTimelineScheduler();
      updateKPIDashboard();
      hasCache = true;
    }
  } catch (e) {
    console.error("Error reading scheduler cache:", e);
  }

  // If we don't have localStorage cache, check if we can populate from state.calendarBookings
  if (!hasCache && state.calendarBookings && state.calendarBookings.length > 0) {
    const filtered = state.calendarBookings.filter(b => b.date === dateStr);
    state.bookings = filtered;
    renderTimelineScheduler();
    updateKPIDashboard();
    hasCache = true;
  }

  // If we have cache, force silent mode to avoid skeleton flashing
  const silentMode = isSilent || hasCache;

  if (!silentMode) showTimelineShimmer(true);
  
  apiCall('getBookings', { date: dateStr }, (err, data) => {
    if (!silentMode) showTimelineShimmer(false);
    if (err) {
      showToast("ไม่สามารถโหลดข้อมูลการจอง: " + err, "error");
      return;
    }
    detectAndNotifyNewBookings(state.bookings, data.bookings);
    state.bookings = mergeServerBookings(state.bookings, data.bookings);
    
    // Save to localStorage cache
    try {
      localStorage.setItem('cached_scheduler_date', dateStr);
      localStorage.setItem('cached_scheduler_bookings', JSON.stringify(state.bookings));
    } catch (e) {
      console.error("Error writing scheduler cache:", e);
    }
    
    renderTimelineScheduler();
    updateKPIDashboard();
  });
}

function fetchTodayBookings(isSilent = false) {
  const todayStr = getFormattedDate(new Date());
  
  try {
    const cachedTodayBookingsStr = localStorage.getItem('cached_today_bookings');
    if (cachedTodayBookingsStr && !state.todayBookings) {
      state.todayBookings = JSON.parse(cachedTodayBookingsStr);
      updateKPIDashboard();
    }
  } catch (e) {
    console.error("Error reading today's bookings cache:", e);
  }

  apiCall('getBookings', { date: todayStr }, (err, data) => {
    if (err) {
      console.error("Error fetching today's bookings:", err);
      return;
    }
    
    state.todayBookings = mergeServerBookings(state.todayBookings, data.bookings);
    
    try {
      localStorage.setItem('cached_today_bookings', JSON.stringify(state.todayBookings));
    } catch (e) {
      console.error("Error writing today's bookings cache:", e);
    }
    
    updateKPIDashboard();
  });
}

/**
 * Fetch current user's bookings
 */
function fetchMyBookings(isSilent = false) {
  const tbody = document.getElementById('my-bookings-table-body');
  
  // Check if we have localStorage cached my bookings
  let hasCache = false;
  try {
    const cachedMyBookingsStr = localStorage.getItem('cached_my_bookings');
    if (cachedMyBookingsStr) {
      state.myBookings = JSON.parse(cachedMyBookingsStr);
      filterMyBookings();
      hasCache = true;
    }
  } catch (e) {
    console.error("Error reading my bookings cache:", e);
  }

  // Fallback: If no cache, try to populate from state.calendarBookings (Zero-Loading optimization)
  if (!hasCache && state.calendarBookings && state.calendarBookings.length > 0) {
    if (state.currentUser && state.currentUser.email) {
      const filtered = state.calendarBookings.filter(b => 
        b.ownerEmail && b.ownerEmail.toLowerCase() === state.currentUser.email.toLowerCase()
      );
      state.myBookings = filtered;
      filterMyBookings();
      hasCache = true;
    }
  }

  const silentMode = isSilent || hasCache;

  if (!silentMode) {
    tbody.innerHTML = skTableRows(8, [
      { w: '15%' },   // วันที่ / เวลา
      { w: '8%' },    // ห้อง
      { w: '15%' },   // แบรนด์ / แคมเปญ
      { w: '22%' },   // รายละเอียด
      { w: '12%' },   // ลิงก์
      { w: '10%' },   // ผู้จอง
      { w: '13%' },   // สถานะรายการ
      { w: '5%' },    // ดำเนินการ
    ]);
  }
  
  apiCall('getMyBookings', {}, (err, data) => {
    if (err) {
      showToast("ไม่สามารถเรียกดูประวัติของฉันได้: " + err, "error");
      return;
    }
    state.myBookings = mergeServerBookings(state.myBookings, data.bookings);
    
    // Save to localStorage cache
    try {
      localStorage.setItem('cached_my_bookings', JSON.stringify(state.myBookings));
    } catch (e) {
      console.error("Error writing my bookings cache:", e);
    }
    
    filterMyBookings();
  });
}

/**
 * Filter and Render My Bookings Tab Table
 */
function filterMyBookings() {
  const searchQuery = document.getElementById('my-bookings-search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('my-bookings-filter-status').value;
  const startFilter = document.getElementById('my-bookings-filter-start-date') ? document.getElementById('my-bookings-filter-start-date').value : "";
  const endFilter = document.getElementById('my-bookings-filter-end-date') ? document.getElementById('my-bookings-filter-end-date').value : "";
  const tbody = document.getElementById('my-bookings-table-body');
  
  let filtered = state.myBookings;
  
  // Ensure the list is filtered to only show the current user's bookings (data privacy)
  if (state.currentUser && state.currentUser.email) {
    filtered = filtered.filter(b => b.ownerEmail && b.ownerEmail.toLowerCase() === state.currentUser.email.toLowerCase());
  }
  
  if (statusFilter !== 'All') {
    filtered = filtered.filter(b => b.status === statusFilter);
  }
  
  if (startFilter) {
    filtered = filtered.filter(b => b.date >= startFilter);
  }
  if (endFilter) {
    filtered = filtered.filter(b => b.date <= endFilter);
  }
  
  if (searchQuery) {
    filtered = filtered.filter(b => 
      String(b.campaignName || '').toLowerCase().includes(searchQuery) || 
      String(b.brandName || '').toLowerCase().includes(searchQuery) ||
      String(b.roomName || '').toLowerCase().includes(searchQuery)
    );
  }
  
  // Sort by date and startTime based on myBookingsSortOrder (Default: desc/latest first)
  filtered.sort((x, y) => {
    const timeX = `${x.date} ${x.startTime}`;
    const timeY = `${y.date} ${y.startTime}`;
    if (state.myBookingsSortOrder === 'desc') {
      return timeY.localeCompare(timeX);
    } else {
      return timeX.localeCompare(timeY);
    }
  });
  
  if (filtered.length === 0) {
    const canCreate = state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canCreateBooking;
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="p-8 text-center text-slate-400">
          <div class="flex flex-col items-center gap-3 py-6">
            <div class="p-4 bg-slate-50 dark:bg-slate-900/50 text-slate-400 rounded-full border border-slate-100 dark:border-slate-800 shadow-inner">
              <i data-lucide="calendar" class="w-8 h-8"></i>
            </div>
            <div class="text-sm font-semibold text-slate-600 dark:text-slate-400">ไม่พบรายการจองของคุณที่ตรงตามตัวกรอง</div>
            <p class="text-xs text-slate-400 max-w-[280px]">คุณยังไม่มีรายการจองคิวสดในช่วงวันที่นี้</p>
            ${canCreate ? `
              <button onclick="openBookingModal()" class="mt-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs font-semibold shadow-md shadow-brand-500/20 flex items-center gap-1.5 transition-all hover:scale-105 active:scale-95">
                <i data-lucide="plus" class="w-3.5 h-3.5"></i> จองห้องไลฟ์สดใหม่
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }
  
  tbody.innerHTML = "";
  filtered.forEach(b => {
    let statusClass = "bg-blue-50 text-blue-700 border-blue-200";
    let statusThText = "จองแล้ว";
    if (b.status === "Completed") {
      statusClass = "bg-emerald-50 text-emerald-700 border-emerald-200";
      statusThText = "เสร็จสิ้น";
    } else if (b.status === "Cancelled") {
      statusClass = "bg-rose-50 text-rose-700 border-rose-200";
      statusThText = "ยกเลิก";
    }
    
    // Disable edit for Cancelled or Completed if not admin, or if no edit permission
    const userRole = getUserRole();
    const canEditPerm = (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canEditBooking) || userRole === 'master admin';
    const isBookingOwner = String(b.ownerEmail || '').toLowerCase() === String(state.currentUser.email || '').toLowerCase();
    const canEdit = (canEditPerm || isBookingOwner) && b.status !== 'Cancelled';
    
    const statusCellHtml = `<span class="px-2.5 py-1 text-xs font-bold rounded-full border ${statusClass}">${statusThText}</span>`;
    
    // Parse artwork links & brief link
    let linksHtml = "";
    const allLinks = [];
    if (b.briefLink) {
      allLinks.push({ type: "Brief", url: b.briefLink });
    }
    if (b.lsArtworkLayout) {
      try {
        const list = JSON.parse(b.lsArtworkLayout);
        if (Array.isArray(list)) {
          list.forEach(item => {
            if (item.url) {
              allLinks.push({ type: item.type || "Link", url: item.url });
            }
          });
        }
      } catch (e) {
        const url = b.lsArtworkLayout.trim();
        if (url.startsWith("http")) {
          allLinks.push({ type: "Artwork", url: url });
        }
      }
    }
    
    if (allLinks.length > 0) {
      const linksList = allLinks.map(item => {
        return `
          <div class="inline-flex items-center gap-1 bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] w-fit">
            <a href="${item.url}" target="_blank" class="hover:underline truncate max-w-[80px]" title="${item.url}">${item.type}</a>
            <button onclick="copyToClipboard('${item.url}')" class="text-slate-400 hover:text-brand-600 p-0.5 focus:outline-none" title="คัดลอกลิงก์">
              <i data-lucide="copy" class="w-2.5 h-2.5"></i>
            </button>
          </div>
        `;
      });
      linksHtml = `<div class="flex flex-wrap gap-1 max-w-[180px]">${linksList.join('')}</div>`;
    } else {
      linksHtml = `<span class="text-slate-400">-</span>`;
    }
    
    tbody.innerHTML += `
      <tr class="hover:bg-slate-50/50">
        <td class="p-4 font-semibold text-slate-900">
          ${formatThaiDate(b.date)}<br>
          <span class="text-xs text-slate-400 font-medium">${b.startTime} - ${b.endTime} น.</span>
        </td>
        <td class="p-4 font-medium text-slate-600">${b.roomName}</td>
        <td class="p-4">
          <div class="font-semibold text-slate-900">${b.campaignName}</div>
          <div class="text-xs text-slate-400">${b.brandName}</div>
        </td>
        <td class="p-4 text-xs text-slate-600 whitespace-pre-line break-words">${b.briefText || '-'}</td>
        <td class="p-4">${linksHtml}</td>
        <td class="p-4 text-xs text-slate-600 break-words">
          <div class="font-semibold text-slate-900">${b.ownerName || '-'}</div>
          <div class="text-[10px] text-slate-400">${b.ownerEmail || ''}</div>
        </td>
        <td class="p-4">${statusCellHtml}</td>
        <td class="p-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            ${canEdit ? `
              <button onclick="duplicateBooking('${b.id}')" class="p-1.5 bg-slate-100 hover:bg-brand-50 hover:text-brand-600 text-slate-600 rounded-md border border-slate-200 hover:border-brand-200 transition-all flex items-center justify-center shrink-0" title="ทำซ้ำ (คัดลอกการจอง)">
                <i data-lucide="copy" class="w-4 h-4"></i>
              </button>
              <button onclick="openBookingEditModal('${b.id}')" class="p-1.5 bg-slate-100 hover:bg-brand-50 hover:text-brand-600 text-slate-600 rounded-md border border-slate-200 hover:border-brand-200 transition-all flex items-center justify-center shrink-0" title="แก้ไขการจอง">
                <i data-lucide="edit-3" class="w-4 h-4"></i>
              </button>
            ` : `
              <button onclick="openBookingEditModal('${b.id}')" class="p-1.5 bg-slate-100 hover:bg-slate-250 text-slate-600 rounded-md border border-slate-200 transition-all flex items-center justify-center shrink-0" title="ดูรายละเอียดการจอง">
                <i data-lucide="eye" class="w-4 h-4"></i>
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  });
  
  // Re-generate Lucide icons for table action buttons (e.g. copy icon)
  lucide.createIcons();
}

/**
 * Clear Date Filter in My Bookings tab
 */
function clearMyBookingsDateFilter() {
  const startInput = document.getElementById('my-bookings-filter-start-date');
  const endInput = document.getElementById('my-bookings-filter-end-date');
  if (startInput) startInput.value = "";
  if (endInput) endInput.value = "";
  filterMyBookings();
}

/**
 * Duplicate an existing booking: pre-fills the creation form
 */
function duplicateBooking(bookingId) {
  if (bookingId && bookingId.toString().startsWith("TEMP_")) {
    showToast("กรุณารอสักครู่ กำลังทำการบันทึกข้อมูลหลักไปยังเซิร์ฟเวอร์", "warning");
    return;
  }
  if (state.currentUser && (getUserRole() === 'viewer' || getUserRole() === 'admin')) {
    showToast("คุณไม่มีสิทธิ์ทำซ้ำรายการจอง", "error");
    return;
  }
  const b = (state.bookings && state.bookings.find(x => x.id === bookingId)) || 
            (state.myBookings && state.myBookings.find(x => x.id === bookingId));
  if (!b) {
    showToast("ไม่พบข้อมูลการจองต้นฉบับ", "error");
    return;
  }
  
  openBookingModal();
  
  // Update Modal Title for Duplication
  document.getElementById('booking-modal-title').innerText = "ทำซ้ำรายการจอง (สร้างจองใหม่)";
  
  // Clear the ID so it creates a new record instead of editing
  document.getElementById('booking-modal-id').value = "";
  
  // Pre-fill the details
  document.getElementById('booking-form-brand').value = b.brandName;
  document.getElementById('booking-form-campaign').value = b.campaignName;
  document.getElementById('booking-form-room').value = b.roomName;
  
  // Leave date empty to force the user to choose the new date, or default to empty
  document.getElementById('booking-form-date').value = "";
  
  document.getElementById('booking-form-start-time').value = b.startTime;
  document.getElementById('booking-form-end-time').value = b.endTime;
  document.getElementById('booking-form-remark').value = b.remark || "";
  document.getElementById('booking-form-status').value = "Confirmed"; // default status for new
  
  // Brief Details
  document.getElementById('booking-form-brief-text').value = b.briefText || "";
  
  // Artwork links pre-filling
  const container = document.getElementById('artwork-links-container');
  const readonlyDisplay = document.getElementById('artwork-links-readonly-display');
  container.innerHTML = "";
  readonlyDisplay.innerHTML = "";
  
  document.getElementById('btn-add-artwork-link').classList.remove('hidden');
  container.classList.remove('hidden');
  readonlyDisplay.classList.add('hidden');
  
  let links = [];
  if (b.lsArtworkLayout) {
    try {
      links = JSON.parse(b.lsArtworkLayout);
    } catch (e) {
      if (typeof b.lsArtworkLayout === 'string' && b.lsArtworkLayout.trim() !== '') {
        links = [{ type: 'Other', url: b.lsArtworkLayout.trim() }];
      }
    }
  }
  
  if (links.length > 0) {
    links.forEach(link => {
      addArtworkLinkRow(link.type, link.url);
    });
  }
  
  // Change Submit Button text
  document.getElementById('btn-save-booking-text').innerText = "ยืนยันการทำซ้ำรายการ";
  document.getElementById('btn-cancel-booking-action').classList.add('hidden'); // No delete in copy mode
  
  showToast("คัดลอกข้อมูลเรียบร้อยแล้ว กรุณาเลือกวันที่ต้องการจองใหม่", "info");
}

/**
 * Handle quick status update directly from the table dropdown
 */
function quickUpdateBookingStatus(bookingId, newStatus) {
  if (state.currentUser && (getUserRole() === 'viewer' || getUserRole() === 'admin')) {
    showToast("คุณไม่มีสิทธิ์แก้ไขสถานะของรายการจองนี้", "error");
    filterMyBookings();
    return;
  }
  const b = (state.bookings && state.bookings.find(x => x.id === bookingId)) || 
            (state.myBookings && state.myBookings.find(x => x.id === bookingId));
  if (!b) {
    showToast("ไม่พบข้อมูลการจอง", "error");
    filterMyBookings();
    return;
  }
  
  // Settle permissions
  const isOwner = b.ownerEmail && state.currentUser && String(b.ownerEmail).toLowerCase() === String(state.currentUser.email).toLowerCase();
  const isAdmin = state.currentUser && (
    (state.currentUser.permissions && state.currentUser.permissions.isAdmin) || 
    getUserRole() === 'master admin'
  );
  if (!isAdmin && !isOwner) {
    showToast("คุณไม่มีสิทธิ์แก้ไขสถานะของรายการจองนี้", "error");
    filterMyBookings();
    return;
  }
  
  if (!isAdmin && (b.status === 'Completed' || b.status === 'Cancelled')) {
    showToast("เฉพาะผู้ดูแลระบบเท่านั้นที่สามารถแก้ไขรายการที่เสร็จสิ้นหรือยกเลิกแล้วได้", "error");
    filterMyBookings();
    return;
  }

  const bookingData = {
    brandName: b.brandName,
    campaignName: b.campaignName,
    roomName: b.roomName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    remark: b.remark || "",
    briefText: b.briefText || "",
    briefLink: b.briefLink || "",
    lsArtworkLayout: b.lsArtworkLayout || "",
    status: newStatus,
    ip: "127.0.0.1",
    device: navigator.userAgent.substring(0, 100)
  };
  
  showLoadingOverlay(true);
  apiCall('updateBooking', { bookingId, bookingData }, (err, data) => {
    showLoadingOverlay(false);
    if (err) {
      showToast("ไม่สามารถอัปเดตสถานะได้: " + err, "error");
      filterMyBookings();
    } else {
      showToast("อัปเดตสถานะการจองสำเร็จ", "success");
      // Invalidate all related caches including campaign schedule so they'll re-fetch
      invalidateTabCache('scheduler', 'my-bookings', 'calendar', 'analytics', 'campaign-schedule');
      refreshActiveTabData();
    }
  });
}

function toggleMyBookingsSort() {
  state.myBookingsSortOrder = state.myBookingsSortOrder === 'desc' ? 'asc' : 'desc';
  const icon = document.getElementById('sort-icon-my-bookings');
  if (icon) {
    icon.innerText = state.myBookingsSortOrder === 'desc' ? '▼' : '▲';
    icon.classList.toggle('text-slate-400', false);
    icon.classList.toggle('text-slate-800', true);
  }
  filterMyBookings();
}

/**
 * KPI Dashboard stats calculator (Fast aggregates)
 */
function updateKPIDashboard() {
  if (!state.todayBookings) {
    // If not loaded yet, wait
    return;
  }
  
  const isMyBookingsTab = (state.currentTab === 'my-bookings');
  let targetBookings = state.todayBookings;
  
  if (isMyBookingsTab && state.currentUser) {
    targetBookings = state.todayBookings.filter(b => b.ownerEmail && b.ownerEmail.toLowerCase() === state.currentUser.email.toLowerCase());
  }
  
  const todayBookingsCount = targetBookings.filter(b => b.status !== 'Cancelled').length;
  
  // Calculate current active and available rooms based on current clock time
  const now = new Date();
  const timeZone = SessionZoneMock(); // Match script timezone
  const currentTimeMins = now.getHours() * 60 + now.getMinutes();
  
  // Global active rooms for physical available rooms count
  let globalActiveRoomsList = new Set();
  state.todayBookings.forEach(b => {
    if (b.status === 'Confirmed') {
      const startMins = parseTimeToMinutes(b.startTime);
      const endMins = parseTimeToMinutes(b.endTime);
      if (currentTimeMins >= startMins && currentTimeMins <= endMins) {
        globalActiveRoomsList.add(b.roomName);
      }
    }
  });
  
  // User active rooms list for User KPI count
  let activeRoomsList = new Set();
  targetBookings.forEach(b => {
    if (b.status === 'Confirmed') {
      const startMins = parseTimeToMinutes(b.startTime);
      const endMins = parseTimeToMinutes(b.endTime);
      if (currentTimeMins >= startMins && currentTimeMins <= endMins) {
        activeRoomsList.add(b.roomName);
      }
    }
  });
  
  const totalRoomsCount = state.rooms.length;
  const activeRoomsCount = activeRoomsList.size;
  const availableRoomsCount = Math.max(0, totalRoomsCount - globalActiveRoomsList.size); // Always show global availability
  
  // Upcoming bookings: starting after now today
  const upcomingBookings = targetBookings.filter(b => {
    if (b.status !== 'Confirmed') return false;
    const startMins = parseTimeToMinutes(b.startTime);
    return startMins > currentTimeMins;
  });
  upcomingBookings.sort((x, y) => parseTimeToMinutes(x.startTime) - parseTimeToMinutes(y.startTime));
  
  const upcomingCount = upcomingBookings.length;
  
  // Update labels dynamically based on current tab
  const labelToday = document.getElementById('kpi-label-today');
  const labelActive = document.getElementById('kpi-label-active');
  const labelUpcoming = document.getElementById('kpi-label-upcoming');
  
  if (isMyBookingsTab) {
    if (labelToday) labelToday.innerText = "My Bookings Today";
    if (labelActive) labelActive.innerText = "My Active Rooms";
    if (labelUpcoming) labelUpcoming.innerText = "My Upcoming Bookings";
  } else {
    if (labelToday) labelToday.innerText = "Booking Today";
    if (labelActive) labelActive.innerText = "Active Rooms";
    if (labelUpcoming) labelUpcoming.innerText = "Upcoming Booking";
  }
  
  // Render values
  document.getElementById('kpi-booking-today').innerText = todayBookingsCount;
  document.getElementById('kpi-active-rooms').innerText = activeRoomsCount;
  document.getElementById('kpi-available-rooms').innerText = availableRoomsCount;
  document.getElementById('kpi-upcoming-bookings').innerText = upcomingCount;
  
  const activeListEl = document.getElementById('kpi-active-rooms-list');
  if (activeListEl) {
    if (activeRoomsCount > 0) {
      const activeRoomsArray = Array.from(activeRoomsList);
      if (activeRoomsCount <= 3) {
        activeListEl.innerText = activeRoomsArray.join(', ');
      } else {
        activeListEl.innerText = `${activeRoomsArray.slice(0, 3).join(', ')} และอีก ${activeRoomsCount - 3} ห้อง...`;
      }
      activeListEl.title = `ห้องที่กำลังไลฟ์ทั้งหมด: ${activeRoomsArray.join(', ')}`;
      activeListEl.classList.remove('hidden');
    } else {
      activeListEl.innerText = "";
      activeListEl.classList.add('hidden');
    }
  }
  
  const upcomingListEl = document.getElementById('kpi-upcoming-bookings-list');
  if (upcomingListEl) {
    if (upcomingCount > 0) {
      const summaries = upcomingBookings.map(b => `${b.roomName} (${b.startTime} น.)`);
      if (upcomingCount <= 3) {
        upcomingListEl.innerText = summaries.join(', ');
      } else {
        upcomingListEl.innerText = `${summaries.slice(0, 3).join(', ')} และอีก ${upcomingCount - 3} รายการ...`;
      }
      upcomingListEl.title = `รายการจองถัดไปทั้งหมด:\n${summaries.join('\n')}`;
      upcomingListEl.classList.remove('hidden');
    } else {
      upcomingListEl.innerText = "";
      upcomingListEl.classList.add('hidden');
    }
  }
  
  // Update Today's Header KPI Badges on Scheduler & Calendar tabs
  updateTodayKpiBadges();
}

/**
 * Update Today's KPI badges (Today's Bookings and Active Rooms) in filter bars
 */
function updateTodayKpiBadges() {
  const todayStr = getFormattedDate(new Date());
  
  // Prioritize using state.todayBookings (if loaded) which is fetched and updated every 30s
  if (state.todayBookings) {
    updateTodayKpiBadgesWithData(state.todayBookings);
    return;
  }

  // If state.bookings contains bookings for today, use it directly (efficient!)
  if (state.bookings && state.selectedDate === todayStr) {
    updateTodayKpiBadgesWithData(state.bookings);
    return;
  }
  
  // Otherwise, filter from state.calendarBookings if loaded
  if (state.calendarBookings && state.calendarBookings.length > 0) {
    const todayBookings = state.calendarBookings.filter(b => b.date === todayStr);
    updateTodayKpiBadgesWithData(todayBookings);
    return;
  }
  
  // Fallback to fetch from backend in the background
  apiCall('getBookings', { date: todayStr }, (err, data) => {
    if (!err && data && data.bookings) {
      updateTodayKpiBadgesWithData(data.bookings);
    }
  });
}

/**
 * Helper to compute stats and write to DOM
 */
function updateTodayKpiBadgesWithData(todayBookings) {
  const activeBookings = todayBookings.filter(b => b.status !== 'Cancelled');
  
  // 1. Calculate Booked Rooms today
  const bookedRooms = new Set();
  activeBookings.forEach(b => {
    bookedRooms.add(b.roomName);
  });
  const bookedRoomsArray = Array.from(bookedRooms);
  const bookedRoomsText = bookedRoomsArray.length > 0 ? bookedRoomsArray.join(', ') : '-';
  
  // 2. Calculate Active Rooms (currently live right now)
  const now = new Date();
  const currentTimeMins = now.getHours() * 60 + now.getMinutes();
  const activeRooms = new Set();
  activeBookings.forEach(b => {
    if (b.status === 'Confirmed') {
      const startMins = parseTimeToMinutes(b.startTime);
      const endMins = parseTimeToMinutes(b.endTime);
      if (currentTimeMins >= startMins && currentTimeMins <= endMins) {
        activeRooms.add(b.roomName);
      }
    }
  });
  const activeRoomsArray = Array.from(activeRooms);
  const activeRoomsText = activeRoomsArray.length > 0 ? activeRoomsArray.join(', ') : '-';
  
  // Update Scheduler DOM
  const schedToday = document.getElementById('scheduler-today-bookings-kpi');
  if (schedToday) schedToday.innerText = bookedRoomsText;
  const schedActive = document.getElementById('scheduler-active-rooms-kpi');
  if (schedActive) schedActive.innerText = activeRoomsText;
  
  // Update Calendar DOM
  const calToday = document.getElementById('calendar-today-bookings-kpi');
  if (calToday) calToday.innerText = bookedRoomsText;
  const calActive = document.getElementById('calendar-active-rooms-kpi');
  if (calActive) calActive.innerText = activeRoomsText;
}

/**
 * Shift Selected Date (+1 or -1 days)
 */
function shiftDate(offset) {
  const current = parseDateSafely(state.selectedDate);
  current.setDate(current.getDate() + offset);
  state.selectedDate = getFormattedDate(current);
  document.getElementById('scheduler-date-picker').value = state.selectedDate;
  fetchBookings(state.selectedDate);
}

function setTodayDate() {
  state.selectedDate = getFormattedDate(new Date());
  document.getElementById('scheduler-date-picker').value = state.selectedDate;
  fetchBookings(state.selectedDate);
}

function handleDatePickerChange(val) {
  if (val) {
    state.selectedDate = val;
    fetchBookings(state.selectedDate);
  }
}

/**
 * Handle timeline search input filtering
 */
function handleSchedulerSearch(query) {
  state.schedulerSearch = query.toLowerCase().trim();
  renderTimelineScheduler();
}

/**
 * RENDER THE MAIN SCHEDULER TIMELINE GRID
 */
function renderTimelineScheduler() {
  const roomsCol = document.getElementById('scheduler-rooms-list');
  const hoursRow = document.getElementById('scheduler-timeline-hours');
  const gridRows = document.getElementById('scheduler-grid-rows');
  
  // 1. Clear out previous HTML elements (preserving column headers)
  roomsCol.innerHTML = `<div class="h-10 border-b border-slate-200 bg-slate-50/50 flex items-center px-4 font-bold text-xs text-slate-500 uppercase tracking-wider">ห้องไลฟ์ (Rooms)</div>`;
  hoursRow.innerHTML = "";
  gridRows.innerHTML = "";
  
  if (state.rooms.length === 0) {
    roomsCol.innerHTML += `<div class="p-4 text-xs text-slate-400 text-center">ไม่มีข้อมูลห้อง</div>`;
    gridRows.innerHTML = `<div class="p-8 text-center text-slate-400 text-sm">ไม่พบการจองในระบบ</div>`;
    return;
  }

  // Calculate active & booked rooms based on current time and selected date bookings
  const now = new Date();
  const currentTimeMins = now.getHours() * 60 + now.getMinutes();
  let activeRoomsList = new Set();
  let bookedRoomsList = new Set();
  state.bookings.forEach(b => {
    if (b.status !== 'Cancelled') {
      bookedRoomsList.add(b.roomName);
    }
    if (b.status === 'Confirmed') {
      const startMins = parseTimeToMinutes(b.startTime);
      const endMins = parseTimeToMinutes(b.endTime);
      if (currentTimeMins >= startMins && currentTimeMins <= endMins) {
        activeRoomsList.add(b.roomName);
      }
    }
  });

  // 2. Render Timeline Hours Headers (00:00 to 24:00 in 1-hour chunks centered)
  for (let h = SCHEDULER_START_HOUR; h < SCHEDULER_END_HOUR; h++) {
    const pad = (h < 10) ? "0" + h : h;
    hoursRow.innerHTML += `
      <div class="h-full border-r border-slate-200 flex-shrink-0 flex items-center justify-center font-bold text-xs text-slate-500" style="min-width: ${CELL_WIDTH_PX * 2}px; width: ${CELL_WIDTH_PX * 2}px;">
        ${pad}:00 น.
      </div>
    `;
  }
  
  const totalMins = (SCHEDULER_END_HOUR - SCHEDULER_START_HOUR) * 60;
  const totalColumns = totalMins / CELL_DURATION_MINS; // 48 columns for 24 hours
  
  // 3. Render Room List Rows & Grid rows
  let renderedCount = 0;
  state.rooms.forEach(room => {
    // Apply Room Filter
    if (state.filters.room && room.name !== state.filters.room) {
      return;
    }

    // Apply Action Filter
    if (state.filters.action === 'booking' && !bookedRoomsList.has(room.name)) {
      return;
    }
    if (state.filters.action === 'active' && !activeRoomsList.has(room.name)) {
      return;
    }

    renderedCount++;

    // Room display cell with active status badge
    const isActive = activeRoomsList.has(room.name);
    const statusText = isActive 
      ? `<span class="flex items-center gap-1 text-[9px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full border border-emerald-100 w-fit mt-0.5 animate-pulse"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>กำลังไลฟ์</span>` 
      : `<span class="text-[10px] text-slate-400 font-medium">ความจุ: ${room.capacity} คน</span>`;
      
    roomsCol.innerHTML += `
      <div class="h-[60px] border-b border-slate-100 px-4 flex flex-col justify-center bg-white">
        <span class="font-bold text-xs text-slate-900">${room.name}</span>
        ${statusText}
      </div>
    `;
    
    // Grid row skeleton
    const rowEl = document.createElement('div');
    rowEl.className = "timeline-row";
    rowEl.style.width = `${totalColumns * CELL_WIDTH_PX}px`;
    
    // Render 30-min cell grids
    for (let c = 0; c < totalColumns; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = "timeline-grid-cell";
      cellEl.style.width = `${CELL_WIDTH_PX}px`;
      
      // Calculate timeslots prefilled on click
      const currentCellMin = SCHEDULER_START_HOUR * 60 + c * CELL_DURATION_MINS;
      const sh = Math.floor(currentCellMin / 60);
      const sm = currentCellMin % 60;
      const eh = Math.floor((currentCellMin + CELL_DURATION_MINS) / 60);
      const em = (currentCellMin + CELL_DURATION_MINS) % 60;
      
      const stStr = `${sh < 10 ? '0'+sh : sh}:${sm < 10 ? '0'+sm : sm}`;
      const etStr = `${eh < 10 ? '0'+eh : eh}:${em < 10 ? '0'+em : em}`;
      cellEl.dataset.mins = currentCellMin;
      cellEl.dataset.startTime = stStr;
      cellEl.dataset.endTime = etStr;
      cellEl.dataset.room = room.name;
      cellEl.dataset.index = c;

      cellEl.onmousedown = (e) => {
         if (state.currentUser && (getUserRole() === 'viewer' || getUserRole() === 'admin')) return;
        state.isDragging = true;
        state.dragStartCell = {
          roomName: room.name,
          index: c,
          mins: currentCellMin,
          el: cellEl
        };
        cellEl.classList.add('bg-brand-100/50', 'dark:bg-brand-900/30', 'border-brand-500/30');
      };
      
      cellEl.onmouseenter = () => {
        if (state.isDragging && state.dragStartCell) {
          if (state.dragStartCell.roomName === room.name) {
            const minIdx = Math.min(state.dragStartCell.index, c);
            const maxIdx = Math.max(state.dragStartCell.index, c);
            
            rowEl.querySelectorAll('.timeline-grid-cell').forEach((cell, idx) => {
              if (idx >= minIdx && idx <= maxIdx) {
                cell.classList.add('bg-brand-100/50', 'dark:bg-brand-900/30', 'border-brand-500/30');
              } else {
                cell.classList.remove('bg-brand-100/50', 'dark:bg-brand-900/30', 'border-brand-500/30');
              }
            });
          }
        }
      };
      
      rowEl.appendChild(cellEl);
    }
    
    // 4. Place Booking Bars over the skeleton row
    const roomBookings = state.bookings.filter(b => {
      if (b.roomId && room.id) {
        return b.roomId === room.id && b.status !== 'Cancelled';
      }
      return b.roomName === room.name && b.status !== 'Cancelled';
    });
    
    roomBookings.forEach(b => {
      // Apply filters
      if (state.filters.brand && b.brandName !== state.filters.brand) {
        return;
      }
      if (state.filters.status && b.status !== state.filters.status) {
        return;
      }

      // Filter searches locally
      if (state.schedulerSearch) {
        const matches = String(b.campaignName || '').toLowerCase().includes(state.schedulerSearch) || String(b.brandName || '').toLowerCase().includes(state.schedulerSearch);
        if (!matches) return; // Skip rendering
      }
      
      const startMins = parseTimeToMinutes(b.startTime);
      const endMins = parseTimeToMinutes(b.endTime);
      const startMinsLimit = SCHEDULER_START_HOUR * 60;
      const endMinsLimit = SCHEDULER_END_HOUR * 60;
      
      // Clip items outside view limit
      if (startMins >= endMinsLimit || endMins <= startMinsLimit) return;
      
      const clippedStart = Math.max(startMins, startMinsLimit);
      const clippedEnd = Math.min(endMins, endMinsLimit);
      
      // Calculate positioning
      const leftPx = (clippedStart - startMinsLimit) * (CELL_WIDTH_PX / CELL_DURATION_MINS);
      const widthPx = (clippedEnd - clippedStart) * (CELL_WIDTH_PX / CELL_DURATION_MINS);
      
      const barEl = document.createElement('div');
      
      // Color class
      let statusTheme = "status-confirmed";
      if (b.status === "Completed") {
        statusTheme = "status-completed";
      } else if (b.status === "Cancelled") {
        statusTheme = "status-cancelled";
      }
      
      barEl.className = `booking-bar ${statusTheme}`;
      barEl.style.left = `${leftPx + 2}px`; // padding adjustment
      barEl.style.width = `${widthPx - 4}px`;
      
      const displayOwner = b.ownerName || (b.ownerEmail ? b.ownerEmail.split('@')[0] : "ไม่ระบุ");
      barEl.title = `แคมเปญ: ${b.campaignName}\nแบรนด์: ${b.brandName}\nเวลา: ${b.startTime} - ${b.endTime}\nผู้จอง: ${displayOwner} (${b.ownerEmail || '-'})`;
      
      barEl.innerHTML = `
        <div class="font-bold truncate text-[11px] leading-tight">
          <span class="bg-black/10 text-slate-800 px-1 py-0.5 rounded-[3px] text-[9px] mr-1 font-bold">${b.brandName}</span>
          ${b.campaignName}
        </div>
        <div class="text-[9px] opacity-90 leading-none flex items-center gap-1 mt-1 truncate">
          <span class="font-semibold text-slate-700 bg-white/80 px-1 py-0.5 rounded-[3px] scale-[0.95] origin-left">${displayOwner}</span>
          <span class="opacity-50">•</span>
          <span>${b.startTime}-${b.endTime}</span>
        </div>
      `;
      
      barEl.onclick = (e) => {
        e.stopPropagation(); // Avoid triggering cell click creation
        openBookingEditModal(b.id);
      };
      
      rowEl.appendChild(barEl);
    });
    
    gridRows.appendChild(rowEl);
  });
  
  if (renderedCount === 0) {
    roomsCol.innerHTML += `<div class="p-4 text-xs text-slate-400 text-center">ไม่พบห้องสตูดิโอ</div>`;
    gridRows.innerHTML = `<div class="p-8 text-center text-slate-400 text-sm">ไม่พบข้อมูลห้องที่ตรงกับตัวกรอง</div>`;
  }
}

/**
 * Grid Shimmer Loading Effect Toggle
 */
function showTimelineShimmer(show) {
  const gridRows = document.getElementById('scheduler-grid-rows');
  if (!gridRows) return;
  if (show) {
    // Build skeleton rows that mimic the real timeline structure
    const skRows = Array.from({ length: 5 }, (_, i) => `
      <div class="sk-timeline-row" style="animation-delay:${i * 0.07}s">
        <div class="sk-cell" style="width:90px"></div>
        <div class="sk-cell" style="width:${40 + Math.random() * 40 | 0}%"></div>
        <div class="sk-cell" style="width:${15 + Math.random() * 20 | 0}%"></div>
        <div class="sk-cell" style="width:60px;margin-left:auto"></div>
      </div>`).join('');
    gridRows.innerHTML = `<div class="w-full">${skRows}</div>`;
  }
}

/**
 * Handle tabs clicks switching views
 */
function switchTab(tabId) {
  const searchEl = document.getElementById('my-bookings-search');
  if (searchEl) searchEl.value = "";
  
  // 1. Dynamic permission checks if allowedTabs list is available
  if (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.allowedTabs) {
    const allowed = state.currentUser.permissions.allowedTabs.split(',').map(t => t.trim().toLowerCase());
    if (!allowed.includes(tabId.toLowerCase())) {
      showToast("คุณไม่มีสิทธิ์เข้าถึงส่วนควบคุมนี้", "error");
      
      // Redirect to first allowed tab, fallback to my-bookings
      if (allowed.length > 0) {
        const fallback = allowed.includes('my-bookings') ? 'my-bookings' : allowed[0];
        if (state.currentTab !== fallback) {
          switchTab(fallback);
        }
      } else {
        if (state.currentTab !== 'my-bookings') {
          switchTab('my-bookings');
        }
      }
      return;
    }
  } else {
    // Legacy fallback check
    const userRole = getUserRole();
    if (userRole === 'admin' && tabId !== 'campaign-schedule') {
      showToast("คุณไม่มีสิทธิ์เข้าถึงส่วนควบคุมนี้", "error");
      if (state.currentTab !== 'campaign-schedule') {
        switchTab('campaign-schedule');
      }
      return;
    }

    const adminTabs = ['rooms', 'brands', 'users', 'roles-mgmt', 'audit-log', 'settings'];
    if (tabId === 'campaign-schedule') {
      if (!state.currentUser || (userRole !== 'master admin' && userRole !== 'admin')) {
        showToast("คุณไม่มีสิทธิ์เข้าถึงส่วนควบคุมนี้", "error");
        if (state.currentTab !== 'my-bookings') {
          switchTab('my-bookings');
        }
        return;
      }
    } else if (adminTabs.includes(tabId) && (!state.currentUser || userRole !== 'master admin')) {
      showToast("คุณไม่มีสิทธิ์เข้าถึงส่วนควบคุมนี้", "error");
      if (state.currentTab !== 'my-bookings') {
        switchTab('my-bookings');
      }
      return;
    }
  }

  state.currentTab = tabId;
  
  // Deactivate all buttons in the sidebar
  document.querySelectorAll('aside nav button').forEach(btn => {
    btn.classList.remove('bg-brand-50', 'text-brand-700', 'dark:bg-brand-900/20', 'dark:text-brand-400');
    btn.classList.add('text-slate-600', 'dark:text-slate-400', 'hover:bg-slate-50', 'dark:hover:bg-slate-800/50');
  });
  
  // Activate selected button in the sidebar (highlight Calendar if on sub-Scheduler view)
  const highlightTabId = tabId === 'scheduler' ? 'calendar' : tabId;
  const activeBtn = document.getElementById(`tab-btn-${highlightTabId}`);
  if (activeBtn) {
    activeBtn.classList.remove('text-slate-600', 'dark:text-slate-400', 'hover:bg-slate-50', 'dark:hover:bg-slate-800/50');
    activeBtn.classList.add('bg-brand-50', 'text-brand-700', 'dark:bg-brand-900/20', 'dark:text-brand-400');
  }
  
  // Hide all panes
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.remove('active');
  });
  
  // Show selected pane
  const activePane = document.getElementById(`tab-${tabId}`);
  if (activePane) {
    activePane.classList.add('active');
  }

  // Show/Hide KPI Section dynamically based on tab (hidden on analytics/statistics tab)
  const kpiSection = document.getElementById('kpi-section');
  if (kpiSection) {
    if (tabId === 'analytics') {
      kpiSection.classList.add('hidden');
    } else {
      kpiSection.classList.remove('hidden');
    }
  }
  
  // Auto-close sidebar on mobile/tablet after selection
  if (window.innerWidth < 768) {
    toggleSidebar(false);
  }
  
  // Audit-log: check unlock state first
  if (tabId === 'audit-log' && !state.auditLogsUnlocked) {
    document.getElementById('audit-log-locked-pane').classList.remove('hidden');
    document.getElementById('audit-log-content-pane').classList.add('hidden');
    return; // Don't fetch data for locked tab
  }

  // ---- Smart Load: only fetch from API on first visit ----
  // Scheduler is keyed by date so check date-specific loaded flag
  const loadKey = tabId === 'scheduler' ? `scheduler_${state.selectedDate}` : tabId;

  // Double requestAnimationFrame: ensures the browser has flushed the DOM layout
  // (tab-pane becomes display:flex and gets real dimensions) BEFORE JS renders the
  // grid. Without this, renderCalendarGrid() runs while the container is still
  // display:none / opacity:0, causing size=0 and invisible content until a click
  // forces a second layout pass.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      updateKPIDashboard();
      if (state.tabLoaded[loadKey]) {
        // Data already in state — just re-render without API call (instant!)
        _rerenderTab(tabId);
      } else {
        // First time visiting this tab (or cache invalidated) — fetch fresh data
        state.tabLoaded[loadKey] = true;
        refreshActiveTabData(false);
      }
      // Make sure Today's KPI Badges are updated on tab switches
      updateTodayKpiBadges();
    });
  });
}

/**
 * Re-render the current tab from existing state (no API call)
 */
function _rerenderTab(tabId) {
  if (tabId === 'scheduler') {
    renderTimelineScheduler();
  } else if (tabId === 'my-bookings') {
    filterMyBookings();
  } else if (tabId === 'calendar') {
    // Reuse calendarBookings already in state — just re-render grid (instant, no API call)
    // Use != null check (not .length >= 0) so that an empty array [] still renders
    // the grid correctly (shows "no bookings" state) without falling through to an
    // async loadCalendarView that leaves the grid blank until API responds.
    if (state.calendarBookings != null) {
      renderCalendarGrid();
    } else {
      loadCalendarView(true);
    }
  } else if (tabId === 'analytics') {
    // Re-render charts from state.calendarBookings (shared pool with calendar)
    if (state.calendarBookings && state.calendarBookings.length > 0) {
      const bookings = state.calendarBookings.filter(b => b.status !== 'Cancelled');
      renderRoomUtilization(bookings);
      renderBrandLeaderboard(bookings);
      renderPeakHours(bookings);
      lucide.createIcons();
    } else {
      loadAnalyticsView(true); // silent fetch
    }
  } else if (tabId === 'campaign-schedule') {
    if (state.calendarBookings && state.calendarBookings.length > 0) {
      renderCampaignSchedule();
    } else {
      loadCampaignScheduleView(true);
    }
  } else if (tabId === 'rooms') {
    fetchRoomsAdmin(state.allRoomsAdmin.length > 0); // silent if data exists
  } else if (tabId === 'brands') {
    fetchBrandsAdmin(state.allBrandsAdmin.length > 0);
  } else if (tabId === 'users') {
    fetchUsersAdmin(state.allUsersAdmin.length > 0);
  } else if (tabId === 'audit-log') {
    renderAuditLogs();
  } else if (tabId === 'settings') {
    loadSettingsTab();
  } else if (tabId === 'roles-mgmt') {
    fetchRolesAdmin(state.allRoles && state.allRoles.length > 0);
  }
}

/**
 * Start Polling Timer (30s)
 */
function startPolling() {
  stopPolling();
  pollingTimer = setInterval(() => {
    refreshActiveTabData(true);
  }, 30000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

// ==================== 4. MODALS & FORMS LOGIC ====================

/**
 * Seed Time intervals into selectors
 */
function populateTimeDropdowns() {
  const startSelect = document.getElementById('booking-form-start-time');
  const endSelect = document.getElementById('booking-form-end-time');
  
  startSelect.innerHTML = "";
  endSelect.innerHTML = "";
  
  for (let h = SCHEDULER_START_HOUR; h <= SCHEDULER_END_HOUR; h++) {
    const pad = (h < 10) ? "0" + h : h;
    
    // Add start time
    if (h < SCHEDULER_END_HOUR) {
      startSelect.innerHTML += `<option value="${pad}:00">${pad}:00 น.</option>`;
      startSelect.innerHTML += `<option value="${pad}:30">${pad}:30 น.</option>`;
    }
    
    // Add end time
    if (h > SCHEDULER_START_HOUR) {
      if (h === SCHEDULER_END_HOUR) {
        endSelect.innerHTML += `<option value="23:59">23:59 น.</option>`;
      } else {
        endSelect.innerHTML += `<option value="${pad}:00">${pad}:00 น.</option>`;
      }
    }
    if (h < SCHEDULER_END_HOUR) {
      endSelect.innerHTML += `<option value="${pad}:30">${pad}:30 น.</option>`;
    }
  }
}

function handleStartTimeChange(startTimeVal) {
  // Automatically offset end-time selection to be +1 hour after start selection for user convenience
  const parts = startTimeVal.split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  
  const endHour = h + 1;
  const pad = (endHour < 10) ? "0" + endHour : endHour;
  const mPad = (m === 30) ? "30" : "00";
  
  const endSelect = document.getElementById('booking-form-end-time');
  
  let val = `${pad}:${mPad}`;
  if (endHour > SCHEDULER_END_HOUR || (endHour === SCHEDULER_END_HOUR && mPad === "30")) {
    val = "23:59";
  } else if (endHour === SCHEDULER_END_HOUR && mPad === "00") {
    val = "23:59";
  }
  
  endSelect.value = val;
}

/**
 * LS Artwork Layout dynamic link row management
 */
function addArtworkLinkRow(type = "Google Drive", url = "") {
  const container = document.getElementById('artwork-links-container');
  const row = document.createElement('div');
  row.className = "artwork-link-row flex items-center gap-2 animate-in fade-in duration-100";
  
  row.innerHTML = `
    <select class="artwork-link-type text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 w-32 shrink-0">
      <option value="Google Drive" ${type === 'Google Drive' ? 'selected' : ''}>Google Drive</option>
      <option value="Canva" ${type === 'Canva' ? 'selected' : ''}>Canva / Canvas</option>
      <option value="Google Sheet" ${type === 'Google Sheet' ? 'selected' : ''}>Google Sheet</option>
      <option value="Other" ${type === 'Other' ? 'selected' : ''}>อื่นๆ (Other)</option>
    </select>
    <input type="url" placeholder="วางลิงก์ https://..." value="${url}" required class="artwork-link-url text-xs border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500 flex-1">
    <button type="button" onclick="removeArtworkLinkRow(this)" class="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg transition-all shrink-0">
      <i data-lucide="trash" class="w-4 h-4"></i>
    </button>
  `;
  
  container.appendChild(row);
  lucide.createIcons();
}

function removeArtworkLinkRow(button) {
  const row = button.closest('.artwork-link-row');
  if (row) {
    row.remove();
  }
}

function getArtworkLinksFromForm() {
  const container = document.getElementById('artwork-links-container');
  const rows = container.querySelectorAll('.artwork-link-row');
  const links = [];
  rows.forEach(row => {
    const type = row.querySelector('.artwork-link-type').value;
    const url = row.querySelector('.artwork-link-url').value.trim();
    if (url) {
      links.push({ type, url });
    }
  });
  return links;
}

/**
 * Open Booking creation prefilled from timeline cell click
 */
function openBookingCreateFromGrid(roomName, startTimeStr, endTimeStr) {
  openBookingModal();
  
  document.getElementById('booking-form-room').value = roomName;
  document.getElementById('booking-form-date').value = state.selectedDate;
  document.getElementById('booking-form-start-time').value = startTimeStr;
  document.getElementById('booking-form-end-time').value = endTimeStr === "24:00" ? "23:59" : endTimeStr;
}

function openBookingModal() {
  _openBookingModalPanel();

  document.getElementById('booking-modal-title').innerText = "จองห้องไลฟ์สดใหม่";
  document.getElementById('booking-form').reset();
  document.getElementById('booking-modal-id').value = "";
  document.getElementById('booking-form-error').classList.add('hidden');
  populateBookingFormBrands();
  populateCampaignSuggestions();
  
  // Hide conflict warning initially
  const conflictAlert = document.getElementById('booking-conflict-alert');
  if (conflictAlert) conflictAlert.classList.add('hidden');

  document.getElementById('btn-cancel-booking-action').classList.add('hidden');
  document.getElementById('booking-form-status-container').classList.add('hidden');
  document.getElementById('booking-form-owner-display').classList.add('hidden');
  
  // Reset new fields
  document.getElementById('booking-form-brief-text').value = "";
  document.getElementById('artwork-links-container').innerHTML = "";
  document.getElementById('artwork-links-readonly-display').innerHTML = "";
  document.getElementById('artwork-links-readonly-display').classList.add('hidden');
  document.getElementById('artwork-links-container').classList.remove('hidden');
  document.getElementById('btn-add-artwork-link').classList.remove('hidden');
  
  // Re-enable form fields
  const canCreate = (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canCreateBooking) || getUserRole() === 'master admin';
  const isViewer = !canCreate;
  const formElements = document.getElementById('booking-form').querySelectorAll('input, select, textarea');
  formElements.forEach(el => {
    el.disabled = isViewer;
  });
  
  const saveBtn = document.getElementById('btn-save-booking');
  if (saveBtn) {
    saveBtn.disabled = false;
    if (isViewer) {
      saveBtn.classList.add('hidden');
    } else {
      saveBtn.classList.remove('hidden');
    }
  }
  
  // Set default date to selectedDate
  document.getElementById('booking-form-date').value = state.selectedDate;
  document.getElementById('btn-save-booking-text').innerText = "บันทึกการจอง";
}

// Internal: just slides the modal panel open
function _openBookingModalPanel() {
  const modal = document.getElementById('booking-modal');
  modal.classList.remove('hidden');
  modal.classList.add('animate-fade-in');
  setTimeout(() => {
    const panel = document.getElementById('booking-modal-panel');
    if (panel) {
      panel.classList.remove('translate-x-full');
      panel.classList.add('translate-x-0');
    }
  }, 10);
}

function closeBookingModal() {
  const panel = document.getElementById('booking-modal-panel');
  if (panel) {
    panel.classList.remove('translate-x-0');
    panel.classList.add('translate-x-full');
  }
  const modal = document.getElementById('booking-modal');
  if (modal) {
    modal.classList.remove('animate-fade-in');
  }
  setTimeout(() => {
    if (modal) modal.classList.add('hidden');
  }, 300);
}

/**
 * Open Booking Editor (Pre-fills existing booking fields)
 */
function openBookingEditModal(bookingId) {
  if (bookingId && bookingId.toString().startsWith("TEMP_")) {
    showToast("กรุณารอสักครู่ กำลังทำการบันทึกข้อมูลหลักไปยังเซิร์ฟเวอร์", "warning");
    return;
  }
  // Search across date-specific bookings, user bookings, and the global calendarBookings pool
  const b = (state.bookings && state.bookings.find(x => x.id && x.id.toString() === bookingId.toString())) || 
            (state.myBookings && state.myBookings.find(x => x.id && x.id.toString() === bookingId.toString())) ||
            (state.calendarBookings && state.calendarBookings.find(x => x.id && x.id.toString() === bookingId.toString()));
  if (!b) return;
  
  // Open the panel WITHOUT resetting the form (form.reset() would wipe the data we're about to fill)
  _openBookingModalPanel();
  
  // Reset error state and hidden UI elements
  document.getElementById('booking-form-error').classList.add('hidden');
  const conflictAlert = document.getElementById('booking-conflict-alert');
  if (conflictAlert) conflictAlert.classList.add('hidden');
  document.getElementById('booking-form-status-container').classList.add('hidden');
  document.getElementById('artwork-links-readonly-display').classList.add('hidden');
  document.getElementById('artwork-links-container').classList.remove('hidden');
  
  // Populate brand dropdown FIRST so the value can be set correctly
  populateBookingFormBrands();
  populateCampaignSuggestions();
  
  document.getElementById('booking-modal-title').innerText = "รายละเอียดและแก้ไขการจอง";
  document.getElementById('booking-modal-id').value = b.id;
  // Populate brand dropdown with THIS booking's brand pre-selected
  populateBookingFormBrands(b.brandName);
  document.getElementById('booking-form-campaign').value = b.campaignName;
  
  // Make sure b.roomName exists as an option in the select dropdown (for historical / renamed rooms)
  const roomSelect = document.getElementById('booking-form-room');
  if (roomSelect && b.roomName) {
    let hasOption = false;
    for (let i = 0; i < roomSelect.options.length; i++) {
      if (roomSelect.options[i].value === b.roomName) {
        hasOption = true;
        break;
      }
    }
    if (!hasOption) {
      const opt = document.createElement('option');
      opt.value = b.roomName;
      opt.text = b.roomName;
      roomSelect.add(opt);
    }
  }
  
  document.getElementById('booking-form-room').value = b.roomName;
  document.getElementById('booking-form-date').value = b.date;
  document.getElementById('booking-form-start-time').value = b.startTime;
  document.getElementById('booking-form-end-time').value = b.endTime;
  document.getElementById('booking-form-remark').value = b.remark || "";
  
  // Load new fields
  document.getElementById('booking-form-brief-text').value = b.briefText || "";
  
  // Check authorization: can edit if they have edit permission (or are master admin) or are the owner
  const currentUserEmail = (state.currentUser && state.currentUser.email) ? state.currentUser.email : '';
  const isOwner = String(b.ownerEmail || '').toLowerCase() === String(currentUserEmail).toLowerCase();
  const userRole = getUserRole();
  const canEdit = (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canEditBooking) || userRole === 'master admin';
  const hasAccess = canEdit || isOwner;
  
  // LS Artwork Layout link processing
  const container = document.getElementById('artwork-links-container');
  const readonlyDisplay = document.getElementById('artwork-links-readonly-display');
  container.innerHTML = "";
  readonlyDisplay.innerHTML = "";
  
  let links = [];
  if (b.lsArtworkLayout) {
    try {
      links = JSON.parse(b.lsArtworkLayout);
    } catch (e) {
      if (typeof b.lsArtworkLayout === 'string' && b.lsArtworkLayout.trim() !== '') {
        links = [{ type: 'Other', url: b.lsArtworkLayout.trim() }];
      }
    }
  }

  const addBtn = document.getElementById('btn-add-artwork-link');
  if (hasAccess) {
    addBtn.classList.remove('hidden');
    container.classList.remove('hidden');
    readonlyDisplay.classList.add('hidden');
    
    if (links.length > 0) {
      links.forEach(link => {
        addArtworkLinkRow(link.type, link.url);
      });
    }
  } else {
    addBtn.classList.add('hidden');
    container.classList.add('hidden');
    readonlyDisplay.classList.remove('hidden');
    
    if (links.length > 0) {
      links.forEach(link => {
        let typeColor = "bg-slate-100 text-slate-700 hover:bg-slate-200 border-slate-200";
        let iconName = "link";
        if (link.type === 'Google Drive') {
          typeColor = "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200";
          iconName = "hard-drive";
        } else if (link.type === 'Canva') {
          typeColor = "bg-purple-50 text-purple-700 hover:bg-purple-100 border-purple-200";
          iconName = "palette";
        } else if (link.type === 'Google Sheet') {
          typeColor = "bg-teal-50 text-teal-700 hover:bg-teal-100 border-teal-200";
          iconName = "table";
        }
        
        readonlyDisplay.innerHTML += `
          <a href="${link.url}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border ${typeColor} transition-all">
            <i data-lucide="${iconName}" class="w-3.5 h-3.5"></i>
            <span>${link.type}: เปิดลิงก์</span>
            <i data-lucide="external-link" class="w-3 h-3 opacity-60"></i>
          </a>
        `;
      });
    } else {
      readonlyDisplay.innerHTML = `<span class="text-xs text-slate-400 font-medium py-1">ไม่มีลิงก์ผลงานแนบไว้</span>`;
    }
    lucide.createIcons();
  }
  
  // Set status value silently but keep it hidden
  const statusContainer = document.getElementById('booking-form-status-container');
  statusContainer.classList.add('hidden');
  document.getElementById('booking-form-status').value = b.status;
  
  // Display ownership
  const ownerDisplay = document.getElementById('booking-form-owner-display');
  ownerDisplay.classList.remove('hidden');
  document.getElementById('booking-owner-name').innerText = b.ownerName || (b.ownerEmail ? b.ownerEmail.split('@')[0] : "ไม่ระบุ");
  document.getElementById('booking-owner-email').innerText = b.ownerEmail || "ไม่ระบุ";
  
  // Display delete/cancel option
  document.getElementById('btn-cancel-booking-action').classList.remove('hidden');
  
  const formElements = document.getElementById('booking-form').querySelectorAll('input, select, textarea');
  formElements.forEach(el => {
    if (el.id !== 'btn-save-booking') {
      el.disabled = !hasAccess;
    }
  });
  
  const saveBtn = document.getElementById('btn-save-booking');
  if (hasAccess) {
    saveBtn.classList.remove('hidden');
    document.getElementById('btn-save-booking-text').innerText = "บันทึกการเปลี่ยนแปลง";
    document.getElementById('btn-cancel-booking-action').classList.remove('hidden');
  } else {
    saveBtn.classList.add('hidden');
    document.getElementById('btn-cancel-booking-action').classList.add('hidden');
  }
}

/**
 * Handle Booking Form Submission (Create or Edit)
 */
function handleBookingSubmit(e) {
  e.preventDefault();
  
  if (state.currentUser && (getUserRole() === 'viewer' || getUserRole() === 'admin')) {
    showToast("คุณไม่มีสิทธิ์จองหรือแก้ไขห้อง", "error");
    return;
  }
  
  const bookingId = document.getElementById('booking-modal-id').value;
  const brandName = document.getElementById('booking-form-brand').value;
  const campaignName = document.getElementById('booking-form-campaign').value;
  const roomName = document.getElementById('booking-form-room').value;
  const dateVal = document.getElementById('booking-form-date').value;
  const startTime = document.getElementById('booking-form-start-time').value;
  const endTime = document.getElementById('booking-form-end-time').value;
  const remark = document.getElementById('booking-form-remark').value;
  const status = document.getElementById('booking-form-status').value;
  
  // Collect new fields
  const briefText = document.getElementById('booking-form-brief-text').value;
  const briefLink = ""; // Removed from UI, keep empty for DB column alignment
  const lsArtworkLayout = JSON.stringify(getArtworkLinksFromForm());
  
  const startMins = parseTimeToMinutes(startTime);
  const endMins = parseTimeToMinutes(endTime);
  
  // Basic Client-side validates
  if (startMins >= endMins) {
    showFormError("เวลาเริ่มจองห้อง ต้องอยู่ก่อนเวลาสิ้นสุด");
    return;
  }
  
  // Look up roomId from state.rooms or state.allRoomsAdmin
  const selectedRoomObj = (state.rooms && state.rooms.find(r => r.name === roomName)) || 
                          (state.allRoomsAdmin && state.allRoomsAdmin.find(r => r.name === roomName));
  const roomId = selectedRoomObj ? selectedRoomObj.id : "";
  
  const bookingData = {
    brandName,
    campaignName,
    roomName,
    date: dateVal,
    startTime,
    endTime,
    remark,
    briefText,
    briefLink,
    lsArtworkLayout,
    status: bookingId ? status : "Confirmed",
    ip: "127.0.0.1",
    device: navigator.userAgent.substring(0, 100),
    roomId
  };
  
  // 1. Close modal immediately to make UI feel instant
  closeBookingModal();
  
  // 2. Show background progress toast
  showToast("กำลังส่งข้อมูลการจองไปยังระบบหลังบ้าน...", "info");
  
  // 3. Create optimistic booking object
  const tempId = "TEMP_" + Date.now();
  const tempBooking = {
    id: bookingId || tempId,
    brandName,
    campaignName,
    roomName,
    date: dateVal,
    startTime,
    endTime,
    remark,
    briefText,
    briefLink,
    lsArtworkLayout,
    ownerEmail: state.currentUser.email,
    ownerName: state.currentUser.name,
    status: bookingId ? status : "Confirmed",
    isOptimistic: true,
    roomId
  };
  
  // 4. Update local state lists immediately
  if (bookingId) {
    if (state.calendarBookings) {
      const idx = state.calendarBookings.findIndex(x => x.id === bookingId);
      if (idx !== -1) {
        state.calendarBookings[idx] = tempBooking;
      }
    }
    if (state.myBookings) {
      const idx = state.myBookings.findIndex(x => x.id === bookingId);
      if (idx !== -1) {
        state.myBookings[idx] = tempBooking;
      }
    }
  } else {
    if (state.calendarBookings) {
      state.calendarBookings.push(tempBooking);
    }
    if (state.myBookings) {
      state.myBookings.unshift(tempBooking);
    }
  }

  // Shift date to newly booked date
  state.selectedDate = dateVal;
  const datePicker = document.getElementById('scheduler-date-picker');
  if (datePicker) datePicker.value = dateVal;

  // Repopulate scheduler bookings list for the new date from calendar bookings cache
  if (state.calendarBookings) {
    state.bookings = state.calendarBookings.filter(b => b.date === dateVal && b.status !== 'Cancelled');
  } else {
    state.bookings = [tempBooking];
  }
  
  // Save updated local states to localStorage immediately to prevent flicker/disappear on background refresh
  try {
    if (state.bookings) {
      localStorage.setItem('cached_scheduler_date', dateVal);
      localStorage.setItem('cached_scheduler_bookings', JSON.stringify(state.bookings));
    }
    if (state.myBookings) {
      localStorage.setItem('cached_my_bookings', JSON.stringify(state.myBookings));
    }
    if (state.calendarBookings) {
      localStorage.setItem('cached_calendar_bookings', JSON.stringify(state.calendarBookings));
    }
  } catch (e) {
    console.error("Error writing optimistic cache to localStorage:", e);
  }
  
  // 5. Instantly render current active tab views
  if (state.currentTab === 'scheduler') {
    renderTimelineScheduler();
  } else if (state.currentTab === 'my-bookings') {
    filterMyBookings();
  } else if (state.currentTab === 'calendar') {
    renderCalendarGrid();
  }
  
  // 6. Send backend write API request in background
  if (bookingId) {
    apiCall('updateBooking', { bookingId, bookingData }, (err, data) => {
      if (err) {
        showToast("เกิดข้อผิดพลาดในการอัปเดตการจอง: " + err, "error");
        // Force refresh to discard optimistic states
        invalidateTabCache('scheduler', 'my-bookings', 'calendar', 'analytics', 'campaign-schedule');
        refreshActiveTabData();
      } else {
        showToast("อัปเดตข้อมูลรายการจองสำเร็จ", "success");
        
        // Mark updated booking as confirmed
        [state.calendarBookings, state.myBookings, state.bookings].forEach(arr => {
          if (arr) {
            const idx = arr.findIndex(x => x.id === bookingId);
            if (idx !== -1) {
              delete arr[idx].isOptimistic;
            }
          }
        });
        
        // Save to localStorage
        try {
          if (state.bookings) {
            localStorage.setItem('cached_scheduler_bookings', JSON.stringify(state.bookings));
          }
          if (state.myBookings) {
            localStorage.setItem('cached_my_bookings', JSON.stringify(state.myBookings));
          }
          if (state.calendarBookings) {
            localStorage.setItem('cached_calendar_bookings', JSON.stringify(state.calendarBookings));
          }
        } catch (e) {}
        
        invalidateTabCache('scheduler', 'my-bookings', 'calendar', 'analytics', 'campaign-schedule');
        refreshActiveTabData(true); // silent refresh (replaces tempBooking with official backend state)
      }
    });
  } else {
    apiCall('createBooking', { bookingData }, (err, data) => {
      if (err) {
        showToast("เกิดข้อผิดพลาดในการสร้างรายการจอง: " + err, "error");
        // Force refresh to discard optimistic states
        invalidateTabCache('scheduler', 'my-bookings', 'calendar', 'analytics', 'campaign-schedule');
        refreshActiveTabData();
      } else {
        showToast("ทำรายการจองห้องไลฟ์สดสำเร็จ", "success");
        
        // Find and promote the optimistic booking to a confirmed one with its real ID
        const realId = data ? data.bookingId : null;
        if (realId) {
          [state.calendarBookings, state.myBookings, state.bookings].forEach(arr => {
            if (arr) {
              const idx = arr.findIndex(x => x.id === tempId);
              if (idx !== -1) {
                arr[idx].id = realId;
                delete arr[idx].isOptimistic;
              }
            }
          });
          
          // Also save the updated arrays immediately to localStorage
          try {
            if (state.bookings) {
              localStorage.setItem('cached_scheduler_bookings', JSON.stringify(state.bookings));
            }
            if (state.myBookings) {
              localStorage.setItem('cached_my_bookings', JSON.stringify(state.myBookings));
            }
            if (state.calendarBookings) {
              localStorage.setItem('cached_calendar_bookings', JSON.stringify(state.calendarBookings));
            }
          } catch (e) {}
        }
        
        invalidateTabCache('scheduler', 'my-bookings', 'calendar', 'analytics', 'campaign-schedule');
        refreshActiveTabData(true); // silent refresh (replaces tempBooking with official backend state)
      }
    });
  }
}

/**
 * Handle Booking Cancellation (Soft Delete)
 */
function deleteCurrentBooking() {
  if (state.currentUser && (getUserRole() === 'viewer' || getUserRole() === 'admin')) {
    showToast("คุณไม่มีสิทธิ์ยกเลิกการจองห้อง", "error");
    return;
  }
  const bookingId = document.getElementById('booking-modal-id').value;
  if (!bookingId) return;
  
  if (confirm("คุณแน่ใจว่าต้องการยกเลิกการจองห้องครั้งนี้?")) {
    showLoadingOverlay(true);
    apiCall('cancelBooking', { bookingId }, (err, data) => {
      showLoadingOverlay(false);
      if (err) {
        showFormError(err);
      } else {
        showToast("ยกเลิกการจองห้องสำเร็จ", "success");
        closeBookingModal();
        invalidateTabCache('scheduler', 'my-bookings', 'calendar', 'analytics', 'campaign-schedule');
        refreshActiveTabData();
      }
    });
  }
}

function showFormError(msg) {
  const errBox = document.getElementById('booking-form-error');
  errBox.classList.remove('hidden');
  document.getElementById('booking-error-text').innerText = msg;
}

// ==================== 5. ADMIN CONTROL PANELS ====================

/**
 * Unlock Audit Log tab via Master Password check
 */
function unlockAuditLog() {
  const password = document.getElementById('audit-master-password-input').value;
  if (!password) {
    showToast("กรุณากรอกรหัสผ่าน", "error");
    return;
  }
  
  showLoadingOverlay(true);
  apiCall('verifyMasterPassword', { password }, (err, data) => {
    showLoadingOverlay(false);
    if (err) {
      showToast(err, "error");
    } else {
      if (data.verified) {
        state.auditLogsUnlocked = true;
        state.auditLogsPassword = password;
        
        document.getElementById('audit-log-locked-pane').classList.add('hidden');
        document.getElementById('audit-log-content-pane').classList.remove('hidden');
        document.getElementById('audit-master-password-input').value = "";
        
        fetchAuditLogs();
      } else {
        showToast("รหัสผ่าน Master Password ไม่ถูกต้อง", "error");
      }
    }
  });
}

function fetchAuditLogs(isSilent = false) {
  const tbody = document.getElementById('audit-logs-table-body');
  if (!isSilent) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center"><div class="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-slate-900"></div></td></tr>`;
  }
  
  apiCall('getActivityLogs', { password: state.auditLogsPassword }, (err, data) => {
    if (err) {
      showToast("ไม่สามารถดึงล็อกความปลอดภัยได้: " + err, "error");
      // relock
      state.auditLogsUnlocked = false;
      switchTab('scheduler');
      return;
    }
    state.auditLogs = data.logs;
    renderAuditLogs();
  });
}

function renderAuditLogs() {
  const tbody = document.getElementById('audit-logs-table-body');
  tbody.innerHTML = "";
  
  // Sort logs by timestamp based on auditLogsSortOrder (Default: desc / latest first)
  const sortedLogs = [...state.auditLogs].sort((x, y) => {
    if (state.auditLogsSortOrder === 'desc') {
      return y.timestamp.localeCompare(x.timestamp);
    } else {
      return x.timestamp.localeCompare(y.timestamp);
    }
  });
  
  sortedLogs.forEach(l => {
    let actionClass = "bg-slate-100 text-slate-700";
    if (l.action.includes("CREATE")) actionClass = "bg-blue-50 text-blue-700";
    else if (l.action.includes("DELETE")) actionClass = "bg-rose-50 text-rose-700";
    else if (l.action.includes("EDIT")) actionClass = "bg-amber-50 text-amber-700";
    
    tbody.innerHTML += `
      <tr class="hover:bg-slate-50/50">
        <td class="p-3 text-[11px] text-slate-500 whitespace-normal break-words">${l.timestamp}</td>
        <td class="p-3 whitespace-normal break-words">
          <div class="font-bold text-slate-800 leading-tight">${l.userName}</div>
          <div class="text-[10px] text-slate-400 break-all">${l.userEmail}</div>
        </td>
        <td class="p-3 text-center"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${actionClass}">${l.action}</span></td>
        <td class="p-3 text-[11px] text-slate-500 whitespace-normal break-words">${l.before}</td>
        <td class="p-3 text-[11px] text-slate-500 whitespace-normal break-words">${l.after}</td>
        <td class="p-3 text-[11px] text-slate-400 font-mono break-all">${l.ip}</td>
        <td class="p-3 text-[10px] text-slate-400 whitespace-normal break-words">${l.device}</td>
      </tr>
    `;
  });
}

function toggleAuditLogsSort() {
  state.auditLogsSortOrder = state.auditLogsSortOrder === 'desc' ? 'asc' : 'desc';
  const icon = document.getElementById('sort-icon-audit-logs');
  if (icon) {
    icon.innerText = state.auditLogsSortOrder === 'desc' ? '▼' : '▲';
    icon.classList.toggle('text-slate-400', false);
    icon.classList.toggle('text-slate-800', true);
  }
  renderAuditLogs();
}

function exportAuditLogs() {
  if (state.auditLogs.length === 0) return;
  
  let csv = "Timestamp,User,Email,Action,Before,After,IP,Device\n";
  state.auditLogs.forEach(l => {
    const cleanBefore = (l.before || "").replace(/"/g, '""');
    const cleanAfter = (l.after || "").replace(/"/g, '""');
    csv += `"${l.timestamp}","${l.userName}","${l.userEmail}","${l.action}","${cleanBefore}","${cleanAfter}","${l.ip}","${l.device}"\n`;
  });
  
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Live_Studio_Audit_Logs_${state.selectedDate}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function triggerManualBackup() {
  if (confirm("ดำเนินการสำรองข้อมูลสเปรดชีต (Backup) บนคลาวด์ตอนนี้หรือไม่?")) {
    showLoadingOverlay(true);
    apiCall('manualBackup', {}, (err, data) => {
      showLoadingOverlay(false);
      if (err) showToast(err, "error");
      else showToast(data.message, "success");
    });
  }
}

function triggerManualArchive() {
  if (confirm("คำเตือน! ย้ายรายการบันทึกประวัติการจองทั้งหมดของปีนี้ไปยังตาราง Archive หรือไม่? ชีตการจองปัจจุบันจะถูกเคลียร์ล้างข้อมูลใหม่")) {
    showLoadingOverlay(true);
    apiCall('manualArchive', {}, (err, data) => {
      showLoadingOverlay(false);
      if (err) showToast(err, "error");
      else showToast(data.message, "success");
    });
  }
}

// ----------------- ADMIN: ROOMS MANAGEMENT -----------------
function renderRoomsTable() {
  const tbody = document.getElementById('admin-rooms-table-body');
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.allRoomsAdmin || state.allRoomsAdmin.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">ไม่มีข้อมูลห้องไลฟ์</td></tr>`;
    return;
  }
  state.allRoomsAdmin.forEach(r => {
    const isAct = r.status === "Active";
    tbody.innerHTML += `
      <tr class="hover:bg-slate-50/50">
        <td class="p-4 font-mono text-xs text-slate-400">${r.id}</td>
        <td class="p-4 font-bold text-slate-800">${r.name}</td>
        <td class="p-4">${r.capacity} คน</td>
        <td class="p-4 text-slate-500 text-xs">${r.description}</td>
        <td class="p-4 text-center">
          <span class="px-2 py-0.5 text-xs font-bold rounded ${isAct ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}">${r.status}</span>
        </td>
        <td class="p-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <button onclick="openRoomEditModal('${r.id}')" class="p-1.5 bg-slate-100 hover:bg-brand-50 hover:text-brand-600 text-slate-600 rounded-md border border-slate-200 hover:border-brand-200 transition-all flex items-center justify-center shrink-0" title="แก้ไข">
              <i data-lucide="edit-3" class="w-4 h-4"></i>
            </button>
            <button onclick="deleteRoomAdmin('${r.id}', '${r.name}')" class="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-md border border-rose-200 hover:border-rose-300 transition-all flex items-center justify-center shrink-0" title="ลบ">
              <i data-lucide="trash" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  });
  lucide.createIcons();
}

function fetchRoomsAdmin(isSilent = false, forceReload = false) {
  const hasData = state.allRoomsAdmin && state.allRoomsAdmin.length > 0;
  
  if (hasData && !forceReload) {
    renderRoomsTable();
    if (isSilent) return;
  }

  const tbody = document.getElementById('admin-rooms-table-body');
  if (!isSilent && !hasData && tbody) {
    tbody.innerHTML = skTableRows(5, [
      { w: '12%' },   // ID
      { w: '22%' },   // ชื่อห้อง
      { w: '10%' },   // ความจุ
      { w: '28%' },   // รายละเอียด
      { w: '10%' },   // สถานะ
      { w: '8%'  },   // action
    ]);
  }
  
  apiCall('manageRooms', { subAction: 'list' }, (err, data) => {
    if (err) {
      showToast(err, "error");
      return;
    }
    state.allRoomsAdmin = data.rooms;
    try {
      localStorage.setItem('cached_all_rooms_admin', JSON.stringify(data.rooms));
    } catch (e) {}
    renderRoomsTable();
  });
}

function openRoomModal() {
  document.getElementById('room-modal').classList.remove('hidden');
  document.getElementById('room-modal-title').innerText = "เพิ่มห้องไลฟ์สดใหม่";
  document.getElementById('room-form').reset();
  document.getElementById('room-form-id').value = "";
  document.getElementById('room-form-status-wrap').classList.add('hidden');
}

function openRoomEditModal(roomId) {
  const r = state.allRoomsAdmin.find(x => x.id === roomId);
  if (!r) return;
  
  openRoomModal();
  document.getElementById('room-modal-title').innerText = "แก้ไขข้อมูลห้องไลฟ์";
  document.getElementById('room-form-id').value = r.id;
  document.getElementById('room-form-name').value = r.name;
  document.getElementById('room-form-capacity').value = r.capacity;
  document.getElementById('room-form-desc').value = r.description;
  document.getElementById('room-form-status-wrap').classList.remove('hidden');
  document.getElementById('room-form-status').value = r.status;
}

function closeRoomModal() {
  document.getElementById('room-modal').classList.add('hidden');
}

function handleRoomSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('room-form-id').value;
  const name = document.getElementById('room-form-name').value.trim();
  const capacity = parseInt(document.getElementById('room-form-capacity').value, 10);
  const description = document.getElementById('room-form-desc').value;
  const status = document.getElementById('room-form-status').value || "Active";
  
  // Check if changing status to Inactive while pending bookings exist
  if (id && status === "Inactive") {
    const originalRoom = state.allRoomsAdmin.find(r => r.id === id);
    const originalName = originalRoom ? originalRoom.name : name;
    if (hasPendingBookingsForRoom(id, originalName)) {
      showToast("ไม่สามารถปิดใช้งานห้องได้ (Inactive) เนื่องจากยังมีรอบไลฟ์ของห้องนี้รอค้างอยู่", "error");
      return;
    }
  }
  
  // Frontend duplicate check
  if (state.allRoomsAdmin && state.allRoomsAdmin.length > 0) {
    const isDuplicate = state.allRoomsAdmin.some(r => 
      r.id !== id && r.name.toString().trim().toLowerCase() === name.toLowerCase()
    );
    if (isDuplicate) {
      showToast("ชื่อห้องนี้มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น!", "error");
      return;
    }
  }
  
  const subAction = id ? 'edit' : 'add';
  const payload = { id, name, capacity, description, status };

  // Backup original state
  const backup = [...state.allRoomsAdmin];

  // Optimistic UI updates
  if (subAction === 'edit') {
    state.allRoomsAdmin = state.allRoomsAdmin.map(r => 
      r.id === id ? { id, name, capacity, description, status } : r
    );
  } else {
    // Generate temporary ID
    const tempId = "RM_temp_" + Date.now();
    state.allRoomsAdmin.push({ id: tempId, name, capacity, description, status: "Active" });
  }

  // Update UI and Toast immediately
  renderRoomsTable();
  closeRoomModal();
  showToast("บันทึกข้อมูลห้องสำเร็จ (กำลังบันทึกหลังบ้าน...)", "success");
  
  apiCall('manageRooms', { subAction, payload }, (err) => {
    if (err) {
      // Rollback on error
      state.allRoomsAdmin = backup;
      renderRoomsTable();
      showToast("ไม่สามารถบันทึกข้อมูลห้องที่หลังบ้านได้: " + err, "error");
    } else {
      showToast("บันทึกข้อมูลห้องสำเร็จแล้ว", "success");
      // Silently reload list to ensure everything matches spreadsheet
      fetchRoomsAdmin(true, true);
      fetchInitData(true); // Reload rooms list in cache silently
    }
  });
}

/**
 * Check if a room has pending/active bookings in frontend state
 */
function hasPendingBookingsForRoom(roomId, roomName) {
  if (!state.calendarBookings) return false;
  
  const now = new Date();
  const todayStr = getFormattedDate(now);
  const currentMins = now.getHours() * 60 + now.getMinutes();
  
  return state.calendarBookings.some(b => {
    if (b.status !== 'Confirmed') return false;
    
    // Match by roomId if available, fallback to roomName
    const isMatch = b.roomId ? (b.roomId === roomId) : (b.roomName === roomName);
    if (!isMatch) return false;
    
    if (b.date > todayStr) return true;
    if (b.date === todayStr) {
      const endMins = parseTimeToMinutes(b.endTime);
      if (endMins > currentMins) return true;
    }
    return false;
  });
}

function deleteRoomAdmin(id, name) {
  if (hasPendingBookingsForRoom(id, name)) {
    showToast("ไม่สามารถลบห้องได้ เนื่องจากยังมีรอบไลฟ์ของห้องนี้รอค้างอยู่", "error");
    return;
  }
  if (confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบห้องไลฟ์สด "${name}"? การดำเนินการนี้จะลบข้อมูลห้องออกจากระบบอย่างถาวร`)) {
    // Backup
    const backup = [...state.allRoomsAdmin];

    // Optimistic UI updates
    state.allRoomsAdmin = state.allRoomsAdmin.filter(r => r.id !== id);

    // Update UI and Toast immediately
    renderRoomsTable();
    showToast("ลบข้อมูลห้องสำเร็จ (กำลังลบหลังบ้าน...)", "success");

    apiCall('manageRooms', { subAction: 'delete', payload: { id } }, (err) => {
      if (err) {
        // Rollback
        state.allRoomsAdmin = backup;
        renderRoomsTable();
        showToast("ไม่สามารถลบข้อมูลห้องที่หลังบ้านได้: " + err, "error");
      } else {
        showToast("ลบข้อมูลห้องสำเร็จแล้ว", "success");
        // Silently reload cache
        fetchInitData(true);
      }
    });
  }
}

// ----------------- ADMIN: BRANDS MANAGEMENT -----------------
function renderBrandsTable() {
  const tbody = document.getElementById('admin-brands-table-body');
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.allBrandsAdmin || state.allBrandsAdmin.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">ไม่มีข้อมูลแบรนด์ลูกค้า</td></tr>`;
    return;
  }
  state.allBrandsAdmin.forEach(b => {
    const isAct = b.status === "Active";
    
    // Find owner display name (ชื่อทีมงาน)
    let ownerDisplay = "-";
    if (b.owner) {
      let usersList = state.allUsersAdmin || [];
      if (usersList.length === 0) {
        try {
          const cached = localStorage.getItem('cached_all_users_admin');
          if (cached) usersList = JSON.parse(cached);
        } catch(e) {}
      }
      const matchedUser = usersList.find(u => u.email.toLowerCase() === b.owner.toLowerCase());
      if (matchedUser) {
        ownerDisplay = `${matchedUser.name} (${matchedUser.email})`;
      } else {
        ownerDisplay = b.owner;
      }
    }
    
    tbody.innerHTML += `
      <tr class="hover:bg-slate-50/50">
        <td class="p-4 font-mono text-xs text-slate-400">${b.id}</td>
        <td class="p-4 font-bold text-slate-800">${b.name}</td>
        <td class="p-4 text-slate-600">${escapeHtml(ownerDisplay)}</td>
        <td class="p-4 text-center">
          <span class="px-2 py-0.5 text-xs font-bold rounded ${isAct ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}">${b.status}</span>
        </td>
        <td class="p-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <button onclick="openBrandEditModal('${b.id}')" class="p-1.5 bg-slate-100 hover:bg-brand-50 hover:text-brand-600 text-slate-600 rounded-md border border-slate-200 hover:border-brand-200 transition-all flex items-center justify-center shrink-0" title="แก้ไข">
              <i data-lucide="edit-3" class="w-4 h-4"></i>
            </button>
            <button onclick="deleteBrandAdmin('${b.id}', '${b.name}')" class="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-md border border-rose-200 hover:border-rose-300 transition-all flex items-center justify-center shrink-0" title="ลบ">
              <i data-lucide="trash" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  });
  lucide.createIcons();
}

function fetchBrandsAdmin(isSilent = false, forceReload = false) {
  const hasData = state.allBrandsAdmin && state.allBrandsAdmin.length > 0;
  
  if (hasData && !forceReload) {
    renderBrandsTable();
    if (isSilent) return;
  }

  const tbody = document.getElementById('admin-brands-table-body');
  if (!isSilent && !hasData && tbody) {
    tbody.innerHTML = skTableRows(5, [
      { w: '12%' },   // ID
      { w: '25%' },   // ชื่อแบรนด์
      { w: '25%' },   // ผู้ดูแล
      { w: '10%' },   // สถานะ
      { w: '8%'  },   // action
    ]);
  }
  
  apiCall('manageBrands', { subAction: 'list' }, (err, data) => {
    if (err) {
      showToast(err, "error");
      return;
    }
    state.allBrandsAdmin = data.brands;
    try {
      localStorage.setItem('cached_all_brands_admin', JSON.stringify(data.brands));
    } catch (e) {}
    renderBrandsTable();
  });
}

function openBrandModal(defaultOwner = "") {
  document.getElementById('brand-modal').classList.remove('hidden');
  document.getElementById('brand-modal-title').innerText = "เพิ่มแบรนด์ลูกค้าใหม่";
  document.getElementById('brand-form').reset();
  document.getElementById('brand-form-id').value = "";
  document.getElementById('brand-form-status-wrap').classList.add('hidden');
  
  const ownerSelect = document.getElementById('brand-form-owner');
  if (ownerSelect) {
    ownerSelect.innerHTML = '<option value="">-- ไม่ระบุผู้ดูแล --</option>';
    
    let usersList = state.allUsersAdmin || [];
    if (usersList.length === 0) {
      try {
        const cachedUsers = localStorage.getItem('cached_all_users_admin');
        if (cachedUsers) usersList = JSON.parse(cachedUsers);
      } catch (e) {}
    }
    
    if (usersList.length === 0) {
      apiCall('manageUsers', { subAction: 'list' }, (err, data) => {
        if (!err && data.users) {
          state.allUsersAdmin = data.users;
          try {
            localStorage.setItem('cached_all_users_admin', JSON.stringify(data.users));
          } catch(e) {}
          populateBrandOwnerDropdown(ownerSelect, data.users, defaultOwner);
        }
      });
    } else {
      populateBrandOwnerDropdown(ownerSelect, usersList, defaultOwner);
    }
  }
}

function populateBrandOwnerDropdown(selectEl, users, selectedVal = "") {
  let html = '<option value="">-- ไม่ระบุผู้ดูแล --</option>';
  users.forEach(u => {
    if (u.status === "Active") {
      html += `<option value="${escapeHtml(u.email)}">${escapeHtml(u.name)} (${escapeHtml(u.email)})</option>`;
    }
  });
  selectEl.innerHTML = html;
  selectEl.value = selectedVal;
}

function openBrandEditModal(brandId) {
  const b = state.allBrandsAdmin.find(x => x.id === brandId);
  if (!b) return;
  
  openBrandModal(b.owner || "");
  document.getElementById('brand-modal-title').innerText = "แก้ไขข้อมูลแบรนด์ลูกค้า";
  document.getElementById('brand-form-id').value = b.id;
  document.getElementById('brand-form-name').value = b.name;
  document.getElementById('brand-form-status-wrap').classList.remove('hidden');
  document.getElementById('brand-form-status').value = b.status;
}

function closeBrandModal() {
  document.getElementById('brand-modal').classList.add('hidden');
}

function handleBrandSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('brand-form-id').value;
  const name = document.getElementById('brand-form-name').value.trim();
  const status = document.getElementById('brand-form-status').value || "Active";
  const owner = document.getElementById('brand-form-owner').value || "";
  
  // Duplicate check for Brands
  if (state.allBrandsAdmin && state.allBrandsAdmin.length > 0) {
    const isDuplicate = state.allBrandsAdmin.some(b => 
      b.id !== id && b.name.toString().trim().toLowerCase() === name.toLowerCase()
    );
    if (isDuplicate) {
      showToast("ชื่อแบรนด์นี้มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น!", "error");
      return;
    }
  }

  const subAction = id ? 'edit' : 'add';
  const payload = { id, name, status, owner };

  // Backup original state
  const backup = [...state.allBrandsAdmin];

  // Optimistic UI updates
  if (subAction === 'edit') {
    state.allBrandsAdmin = state.allBrandsAdmin.map(b => 
      b.id === id ? { id, name, status, owner } : b
    );
  } else {
    // Generate temporary ID
    const tempId = "BR_temp_" + Date.now();
    state.allBrandsAdmin.push({ id: tempId, name, status: "Active", owner });
  }

  // Update UI and Toast immediately
  renderBrandsTable();
  closeBrandModal();
  showToast("บันทึกข้อมูลแบรนด์สำเร็จ (กำลังบันทึกหลังบ้าน...)", "success");
  
  apiCall('manageBrands', { subAction, payload }, (err) => {
    if (err) {
      // Rollback on error
      state.allBrandsAdmin = backup;
      renderBrandsTable();
      showToast("ไม่สามารถบันทึกข้อมูลแบรนด์ที่หลังบ้านได้: " + err, "error");
    } else {
      showToast("บันทึกข้อมูลแบรนด์สำเร็จแล้ว", "success");
      // Silently reload list to ensure everything matches spreadsheet
      fetchBrandsAdmin(true, true);
      fetchInitData(true); // Reload brands list in cache silently
    }
  });
}

function deleteBrandAdmin(id, name) {
  if (confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบแบรนด์ลูกค้า "${name}"? การดำเนินการนี้จะลบข้อมูลแบรนด์ออกจากระบบอย่างถาวร`)) {
    // Backup
    const backup = [...state.allBrandsAdmin];

    // Optimistic UI updates
    state.allBrandsAdmin = state.allBrandsAdmin.filter(b => b.id !== id);

    // Update UI and Toast immediately
    renderBrandsTable();
    showToast("ลบข้อมูลแบรนด์สำเร็จ (กำลังลบหลังบ้าน...)", "success");

    apiCall('manageBrands', { subAction: 'delete', payload: { id } }, (err) => {
      if (err) {
        // Rollback
        state.allBrandsAdmin = backup;
        renderBrandsTable();
        showToast("ไม่สามารถลบข้อมูลแบรนด์ที่หลังบ้านได้: " + err, "error");
      } else {
        showToast("ลบข้อมูลแบรนด์สำเร็จแล้ว", "success");
        // Silently reload cache
        fetchInitData(true);
      }
    });
  }
}

// ----------------- ADMIN: ROLES MANAGEMENT -----------------
function renderRolesTable() {
  const tbody = document.getElementById('admin-roles-table-body');
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.allRoles || state.allRoles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">ไม่มีข้อมูลบทบาทและระดับสิทธิ์</td></tr>`;
    return;
  }
  
  state.allRoles.forEach(r => {
    // Format allowed tabs cleanly
    const allowedList = (r.allowedTabs || "").split(',')
      .map(t => {
        const labels = {
          'my-bookings': 'การจองของฉัน',
          'calendar': 'ปฏิทินรายเดือน',
          'scheduler': 'ตารางจองรวม Timeline',
          'campaign-schedule': 'ตารางงานแคมเปญ List',
          'analytics': 'รายงานสถิติ',
          'rooms': 'ห้องไลฟ์',
          'brands': 'แบรนด์',
          'users': 'สิทธิ์ผู้ใช้งาน',
          'audit-log': 'ประวัติกิจกรรม',
          'settings': 'ตั้งค่าระบบ',
          'roles-mgmt': 'ระดับสิทธิ์ Roles'
        };
        return labels[t.trim()] || t.trim();
      })
      .join(', ');
      
    // Format permissions cleanly
    const perms = [];
    if (r.canCreateBooking) perms.push("สร้าง");
    if (r.canEditBooking) perms.push("แก้ไข");
    if (r.canCancelBooking) perms.push("ยกเลิก");
    const permsStr = perms.length > 0 ? perms.join('/') : "ไม่มีสิทธิ์จอง";
    
    // Check if critical default role (Master Admin)
    const isCritical = r.roleName.toLowerCase() === "master admin";
    
    tbody.innerHTML += `
      <tr class="hover:bg-slate-50/50">
        <td class="p-4 font-bold text-slate-800">${escapeHtml(r.roleName)}</td>
        <td class="p-4 text-slate-500 text-xs">${escapeHtml(r.description || "-")}</td>
        <td class="p-4 text-center text-slate-600 text-xs font-semibold">${escapeHtml(permsStr)}</td>
        <td class="p-4 text-center">
          <span class="px-2 py-0.5 text-xs font-bold rounded ${r.isAdmin ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-400'}">${r.isAdmin ? 'Yes' : 'No'}</span>
        </td>
        <td class="p-4 text-slate-500 text-xs max-w-[250px] truncate" title="${escapeHtml(allowedList)}">${escapeHtml(allowedList)}</td>
        <td class="p-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <button onclick="openRoleEditModal('${escapeHtml(r.roleName)}')" class="p-1.5 bg-slate-100 hover:bg-brand-50 hover:text-brand-600 text-slate-600 rounded-md border border-slate-200 hover:border-brand-200 transition-all flex items-center justify-center shrink-0" title="แก้ไข">
              <i data-lucide="edit-3" class="w-4 h-4"></i>
            </button>
            ${isCritical ? `
              <span class="w-7 text-center text-slate-300" title="บทบาทเริ่มต้น ลบไม่ได้">-</span>
            ` : `
              <button onclick="deleteRoleAdmin('${escapeHtml(r.roleName)}')" class="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-md border border-rose-200 hover:border-rose-300 transition-all flex items-center justify-center shrink-0" title="ลบ">
                <i data-lucide="trash" class="w-4 h-4"></i>
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  });
  lucide.createIcons();
}

function fetchRolesAdmin(isSilent = false, forceReload = false) {
  if (state.allRoles && state.allRoles.length > 0 && !forceReload) {
    renderRolesTable();
    if (isSilent) return;
  }
  
  const tbody = document.getElementById('admin-roles-table-body');
  if (!isSilent && tbody) {
    tbody.innerHTML = skTableRows(6, [
      { w: '18%' }, // Role Name
      { w: '22%' }, // Description
      { w: '18%' }, // Permissions
      { w: '12%' }, // Is Admin
      { w: '22%' }, // Allowed Tabs
      { w: '8%'  }  // Action
    ]);
  }
  
  apiCall('manageRoles', { subAction: 'list' }, (err, data) => {
    if (!err && data.roles) {
      state.allRoles = data.roles;
      try {
        localStorage.setItem('cached_all_roles_admin', JSON.stringify(data.roles));
      } catch(e) {}
    }
    renderRolesTable();
  });
}

function openRoleModal() {
  document.getElementById('role-modal').classList.remove('hidden');
  document.getElementById('role-modal-title').innerText = "เพิ่มบทบาทสิทธิ์ผู้ใช้ใหม่";
  document.getElementById('role-form').reset();
  document.getElementById('role-form-name').disabled = false;
  document.getElementById('role-form-is-edit').value = "false";
}

function openRoleEditModal(roleName) {
  const r = state.allRoles.find(x => x.roleName.toLowerCase() === roleName.toLowerCase());
  if (!r) return;
  
  openRoleModal();
  document.getElementById('role-modal-title').innerText = "แก้ไขระดับสิทธิ์ผู้ใช้";
  document.getElementById('role-form-name').value = r.roleName;
  document.getElementById('role-form-name').disabled = true; // Key cannot be edited
  document.getElementById('role-form-is-edit').value = "true";
  document.getElementById('role-form-description').value = r.description || "";
  document.getElementById('role-form-can-create').checked = r.canCreateBooking;
  document.getElementById('role-form-can-edit').checked = r.canEditBooking;
  document.getElementById('role-form-can-cancel').checked = r.canCancelBooking;
  document.getElementById('role-form-is-admin').checked = r.isAdmin;
  
  // Set tab checkboxes
  const allowed = (r.allowedTabs || "").split(',').map(t => t.trim().toLowerCase());
  document.querySelectorAll('.role-form-tab-checkbox').forEach(cb => {
    cb.checked = allowed.includes(cb.value.toLowerCase());
  });
}

// Global scope bindings for inline calls
window.openRoleModal = openRoleModal;
window.openRoleEditModal = openRoleEditModal;
window.closeRoleModal = closeRoleModal;
window.handleRoleSubmit = handleRoleSubmit;
window.deleteRoleAdmin = deleteRoleAdmin;
window.populateUserRoleDropdown = populateUserRoleDropdown;

function closeRoleModal() {
  document.getElementById('role-modal').classList.add('hidden');
}

function handleRoleSubmit(e) {
  e.preventDefault();
  const roleName = document.getElementById('role-form-name').value.trim();
  const description = document.getElementById('role-form-description').value.trim();
  const canCreateBooking = document.getElementById('role-form-can-create').checked;
  const canEditBooking = document.getElementById('role-form-can-edit').checked;
  const canCancelBooking = document.getElementById('role-form-can-cancel').checked;
  const isAdmin = document.getElementById('role-form-is-admin').checked;
  
  // Collect checked allowed tabs
  const allowedTabs = [];
  document.querySelectorAll('.role-form-tab-checkbox').forEach(cb => {
    if (cb.checked) allowedTabs.push(cb.value);
  });
  
  const isEdit = document.getElementById('role-form-is-edit').value === "true";
  const subAction = isEdit ? 'edit' : 'add';
  const payload = {
    roleName,
    description,
    canCreateBooking,
    canEditBooking,
    canCancelBooking,
    isAdmin,
    allowedTabs: allowedTabs.join(',')
  };
  
  const backup = [...(state.allRoles || [])];
  
  // Optimistic update
  if (!state.allRoles) state.allRoles = [];
  if (isEdit) {
    state.allRoles = state.allRoles.map(x => x.roleName.toLowerCase() === roleName.toLowerCase() ? payload : x);
  } else {
    state.allRoles.push(payload);
  }
  
  renderRolesTable();
  closeRoleModal();
  showToast("บันทึกบทบาทสิทธิ์สำเร็จ (กำลังบันทึกหลังบ้าน...)", "success");
  
  apiCall('manageRoles', { subAction, payload }, (err) => {
    if (err) {
      state.allRoles = backup;
      renderRolesTable();
      showToast("ไม่สามารถบันทึกบทบาทสิทธิ์ได้: " + err, "error");
    } else {
      showToast("บันทึกบทบาทสิทธิ์สำเร็จแล้ว", "success");
      fetchRolesAdmin(true, true);
      fetchInitData(true);
    }
  });
}

function deleteRoleAdmin(roleName) {
  if (confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบระดับสิทธิ์ "${roleName}"? ผู้ใช้งานที่ใช้บทบาทนี้จะถูกลดสิทธิ์ขั้นพื้นฐานทันที`)) {
    const backup = [...state.allRoles];
    state.allRoles = state.allRoles.filter(x => x.roleName.toLowerCase() !== roleName.toLowerCase());
    renderRolesTable();
    showToast("ลบบทบาทสิทธิ์สำเร็จ (กำลังประมวลผล...)", "success");
    
    apiCall('manageRoles', { subAction: 'delete', payload: { roleName } }, (err) => {
      if (err) {
        state.allRoles = backup;
        renderRolesTable();
        showToast("ไม่สามารถลบสิทธิ์ที่หลังบ้านได้: " + err, "error");
      } else {
        showToast("ลบบทบาทสิทธิ์เสร็จสมบูรณ์", "success");
        fetchRolesAdmin(true, true);
      }
    });
  }
}

function populateUserRoleDropdown(selectedVal = "") {
  const selectEl = document.getElementById('user-form-role');
  if (!selectEl) return;
  
  let rolesList = state.allRoles || [];
  if (rolesList.length === 0) {
    try {
      const cached = localStorage.getItem('cached_all_roles_admin');
      if (cached) rolesList = JSON.parse(cached);
    } catch(e) {}
  }
  if (rolesList.length === 0) {
    rolesList = [
      { roleName: "Viewer", description: "ดูได้อย่างเดียว" },
      { roleName: "Campaign Manager", description: "จอง/จัดการของตัวเอง" },
      { roleName: "Admin", description: "ดูงานแคมเปญ & ลิงก์ไดรฟ์" },
      { roleName: "Master Admin", description: "แอดมินสิทธิ์สูงสุด" }
    ];
  }
  
  let html = "";
  rolesList.forEach(r => {
    const descText = r.description ? ` (${r.description})` : '';
    html += `<option value="${escapeHtml(r.roleName)}">${escapeHtml(r.roleName)}${escapeHtml(descText)}</option>`;
  });
  
  selectEl.innerHTML = html;
  if (selectedVal) {
    // Match case-insensitively
    const valLower = selectedVal.toLowerCase();
    for (let opt of selectEl.options) {
      if (opt.value.toLowerCase() === valLower) {
        selectEl.value = opt.value;
        break;
      }
    }
  }
}

// ----------------- ADMIN: USERS MANAGEMENT -----------------
function renderUsersTable() {
  const tbody = document.getElementById('admin-users-table-body');
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.allUsersAdmin || state.allUsersAdmin.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">ไม่มีข้อมูลผู้ใช้งาน</td></tr>`;
    return;
  }
  state.allUsersAdmin.forEach(u => {
    const isAct = u.status === "Active";
    tbody.innerHTML += `
      <tr class="hover:bg-slate-50/50">
        <td class="p-4 font-semibold text-slate-800">${u.email}</td>
        <td class="p-4 font-medium text-slate-600">${u.name}</td>
        <td class="p-4"><span class="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs font-semibold">${u.role}</span></td>
        <td class="p-4 text-center">
          <span class="px-2 py-0.5 text-xs font-bold rounded ${isAct ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}">${u.status}</span>
        </td>
        <td class="p-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <button onclick="openUserEditModal('${u.email}')" class="p-1.5 bg-slate-100 hover:bg-brand-50 hover:text-brand-600 text-slate-600 rounded-md border border-slate-200 hover:border-brand-200 transition-all flex items-center justify-center shrink-0" title="แก้ไข">
              <i data-lucide="edit-3" class="w-4 h-4"></i>
            </button>
            <button onclick="deleteUserAdmin('${u.email}')" class="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-md border border-rose-200 hover:border-rose-300 transition-all flex items-center justify-center shrink-0" title="ลบ">
              <i data-lucide="trash" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  });
  lucide.createIcons();
}

function fetchUsersAdmin(isSilent = false, forceReload = false) {
  const hasData = state.allUsersAdmin && state.allUsersAdmin.length > 0;
  
  if (hasData && !forceReload) {
    renderUsersTable();
    if (isSilent) return;
  }

  const tbody = document.getElementById('admin-users-table-body');
  if (!isSilent && !hasData && tbody) {
    tbody.innerHTML = skTableRows(5, [
      { w: '22%' },   // อีเมล
      { w: '18%' },   // ชื่อ
      { w: '14%' },   // ตำแหน่ง
      { w: '10%' },   // สถานะ
      { w: '8%'  },   // action
    ]);
  }
  
  apiCall('manageUsers', { subAction: 'list' }, (err, data) => {
    if (err) {
      showToast(err, "error");
      return;
    }
    state.allUsersAdmin = data.users;
    try {
      localStorage.setItem('cached_all_users_admin', JSON.stringify(data.users));
    } catch (e) {}
    renderUsersTable();
  });
}

function openUserModal() {
  populateUserRoleDropdown();
  document.getElementById('user-modal').classList.remove('hidden');
  document.getElementById('user-modal-title').innerText = "เพิ่มสิทธิ์ผู้ใช้งานใหม่";
  document.getElementById('user-form').reset();
  document.getElementById('user-form-email').disabled = false;
  document.getElementById('user-form-password').value = "";
  document.getElementById('user-form-status-wrap').classList.add('hidden');
}

function openUserEditModal(email) {
  const u = state.allUsersAdmin.find(x => x.email === email);
  if (!u) return;
  
  populateUserRoleDropdown(u.role);
  document.getElementById('user-modal').classList.remove('hidden');
  document.getElementById('user-modal-title').innerText = "แก้ไขระดับสิทธิ์ผู้ใช้";
  document.getElementById('user-form-email').value = u.email;
  document.getElementById('user-form-email').disabled = true; // Email is primary key
  document.getElementById('user-form-password').value = u.password || "";
  document.getElementById('user-form-name').value = u.name;
  
  const roleSelect = document.getElementById('user-form-role');
  if (roleSelect && !roleSelect.value) {
    const valToFind = String(u.role || '').trim().toLowerCase();
    for (let opt of roleSelect.options) {
      if (opt.value.toLowerCase() === valToFind) {
        roleSelect.value = opt.value;
        break;
      }
    }
  }
  document.getElementById('user-form-status-wrap').classList.remove('hidden');
  document.getElementById('user-form-status').value = u.status;
}

function closeUserModal() {
  document.getElementById('user-modal').classList.add('hidden');
}

function handleUserSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('user-form-email').value.trim();
  const password = document.getElementById('user-form-password').value.trim();
  const name = document.getElementById('user-form-name').value.trim();
  const role = document.getElementById('user-form-role').value;
  const status = document.getElementById('user-form-status').value || "Active";
  
  const isEdit = document.getElementById('user-modal-title').innerText.includes("แก้ไข");
  const subAction = isEdit ? 'edit' : 'add';
  const payload = { email, password, name, role, status };

  // Backup original state
  const backup = [...state.allUsersAdmin];

  // Optimistic UI updates
  if (isEdit) {
    state.allUsersAdmin = state.allUsersAdmin.map(u => 
      u.email.toLowerCase() === email.toLowerCase() ? { email, password, name, role, status } : u
    );
  } else {
    // Check duplicate email on add
    if (state.allUsersAdmin && state.allUsersAdmin.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      showToast("อีเมล/ชื่อผู้ใช้งานนี้มีอยู่ในระบบแล้ว!", "error");
      return;
    }
    state.allUsersAdmin.push({ email, password, name, role, status });
  }

  // Update UI and Toast immediately
  renderUsersTable();
  closeUserModal();
  showToast("บันทึกข้อมูลสิทธิ์ผู้ใช้สำเร็จ (กำลังบันทึกหลังบ้าน...)", "success");
  
  apiCall('manageUsers', { subAction, payload }, (err) => {
    if (err) {
      // Rollback
      state.allUsersAdmin = backup;
      renderUsersTable();
      showToast("ไม่สามารถบันทึกข้อมูลผู้ใช้ที่หลังบ้านได้: " + err, "error");
    } else {
      showToast("บันทึกข้อมูลสิทธิ์ผู้ใช้สำเร็จแล้ว", "success");
      // Silently reload list to ensure everything matches spreadsheet
      fetchUsersAdmin(true, true);
      fetchInitData(true);
    }
  });
}

function deleteUserAdmin(email) {
  if (email.toLowerCase() === state.currentUser.email.toLowerCase()) {
    showToast("คุณไม่สามารถลบบัญชีผู้ใช้งานของตัวเองได้", "error");
    return;
  }
  if (confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบสิทธิ์ผู้ใช้งาน "${email}"? การดำเนินการนี้จะลบข้อมูลสิทธิ์ออกจากระบบอย่างถาวร`)) {
    // Backup
    const backup = [...state.allUsersAdmin];

    // Optimistic UI updates
    state.allUsersAdmin = state.allUsersAdmin.filter(u => u.email.toLowerCase() !== email.toLowerCase());

    // Update UI and Toast immediately
    renderUsersTable();
    showToast("ลบข้อมูลผู้ใช้งานสำเร็จ (กำลังลบหลังบ้าน...)", "success");

    apiCall('manageUsers', { subAction: 'delete', payload: { email } }, (err) => {
      if (err) {
        // Rollback
        state.allUsersAdmin = backup;
        renderUsersTable();
        showToast("ไม่สามารถลบข้อมูลผู้ใช้ที่หลังบ้านได้: " + err, "error");
      } else {
        showToast("ลบข้อมูลผู้ใช้งานสำเร็จแล้ว", "success");
      }
    });
  }
}

// ----------------- ADMIN: PASSWORDS MANAGEMENT -----------------
function openChangePasswordModal() {
  document.getElementById('change-password-modal').classList.remove('hidden');
  document.getElementById('change-password-form').reset();
}

function closeChangePasswordModal() {
  document.getElementById('change-password-modal').classList.add('hidden');
}

function handleChangePasswordSubmit(e) {
  e.preventDefault();
  const oldPassword = document.getElementById('change-password-old').value;
  const newPassword = document.getElementById('change-password-new').value;
  const confirmPassword = document.getElementById('change-password-confirm').value;
  
  if (newPassword !== confirmPassword) {
    showToast("รหัสผ่านใหม่ไม่ตรงกัน", "error");
    return;
  }
  
  showLoadingOverlay(true);
  apiCall('changeMasterPassword', { oldPassword, newPassword }, (err, data) => {
    showLoadingOverlay(false);
    if (err) {
      showToast(err, "error");
    } else {
      showToast(data.message, "success");
      closeChangePasswordModal();
      // Cache new unlocked password
      state.auditLogsPassword = newPassword;
    }
  });
}

// ==================== 6. HELPER FUNCTIONS ====================

/**
 * Main API request execution helper
 * Handles redirection, headers, credentials injection, and error formatting
 */
function apiCall(action, payload, callback) {
  if (state.isMockMode) {
    executeMockCall(action, payload, callback);
    return;
  }
  
  const payloadData = {
    action: action,
    token: state.authToken,
    ...payload
  };
  
  // Use text/plain for simple CORS requests without triggering OPTIONS preflight
  fetch(GAS_API_URL, {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(payloadData)
  })
  .then(res => {
    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status}`);
    }
    return res.json();
  })
  .then(data => {
    // If user has logged out while request was in flight, discard response
    if (!state.authToken) {
      console.warn(`Response received for action "${action}" but user is logged out. Ignoring.`);
      return;
    }
    if (data.success) {
      callback(null, data);
    } else {
      callback(data.message || "Unknown error", null);
    }
  })
  .catch(err => {
    // If user has logged out while request was in flight, discard error
    if (!state.authToken) {
      console.warn(`Error received for action "${action}" but user is logged out. Ignoring.`);
      return;
    }
    console.error("API Call error details: ", err);
    callback(`เชื่อมต่อเซิร์ฟเวอร์หลังบ้านล้มเหลว: ${err.message}. กรุณาตรวจความถูกต้องของ GAS URL หรือตั้งค่าสิทธิ์ Web App ใน Google App Script ให้เป็น Anyone.`, null);
  });
}

/**
 * Decode JWT token payload
 */
function decodeJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.error("JWT decoding failed", e);
    return null;
  }
}

/**
 * Toast notifications drawer
 */
function showToast(message, type = "success") {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  let bgClass = "bg-white text-slate-800 border-slate-200";
  let icon = "check-circle";
  let iconColor = "text-emerald-500";
  
  if (type === "success") {
    bgClass = "bg-emerald-950 text-emerald-50 border-emerald-800 shadow-emerald-950/20";
    icon = "check-circle";
    iconColor = "text-emerald-400";
  } else if (type === "error") {
    bgClass = "bg-rose-950 text-rose-50 border-rose-800 shadow-rose-950/20";
    icon = "alert-triangle";
    iconColor = "text-rose-400";
  } else if (type === "warning") {
    bgClass = "bg-amber-950 text-amber-50 border-amber-800 shadow-amber-950/20";
    icon = "info";
    iconColor = "text-amber-400";
  } else if (type === "info") {
    bgClass = "bg-indigo-950 text-indigo-50 border-indigo-800 shadow-indigo-950/20";
    icon = "bell";
    iconColor = "text-indigo-400";
  }
  
  toast.className = `glass-modal p-4 rounded-xl border flex items-center gap-3 shadow-lg transform transition-all duration-300 translate-y-2 opacity-0 ${bgClass}`;
  toast.innerHTML = `
    <i data-lucide="${icon}" class="w-5 h-5 ${iconColor} flex-shrink-0"></i>
    <span class="text-xs font-semibold leading-normal">${message}</span>
  `;
  
  container.appendChild(toast);
  lucide.createIcons();
  
  // Animate Entrance
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);
  
  // Animate Exit
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-[-10px]');
    setTimeout(() => {
      container.removeChild(toast);
    }, 300);
  }, 3500);
}

/**
 * UI loading overlays
 */
function showLoadingOverlay(show) {
  let overlay = document.getElementById('global-loading-overlay');
  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'global-loading-overlay';
      overlay.className = "fixed inset-0 bg-slate-950/20 backdrop-blur-sm z-[999] flex items-center justify-center";
      overlay.innerHTML = `
        <div class="glass-modal p-5 rounded-2xl shadow-xl flex flex-col items-center gap-3">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
          <span class="text-xs font-bold text-slate-700">กำลังประมวลผลระบบ...</span>
        </div>
      `;
      document.body.appendChild(overlay);
    }
  } else {
    if (overlay) {
      document.body.removeChild(overlay);
    }
  }
}

/**
 * Dates formatter helpers
 */
// Parse YYYY-MM-DD safely across all browsers (safely handles Safari/iOS quirks)
function parseDateSafely(dateStr) {
  if (!dateStr) return new Date();
  if (dateStr instanceof Date) return dateStr;
  const parts = dateStr.toString().split('-');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      return new Date(y, m, d);
    }
  }
  return new Date(dateStr);
}

function getFormattedDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatThaiDate(dateStr) {
  const months = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
  ];
  const date = parseDateSafely(dateStr);
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear() + 543}`;
}

function parseTimeToMinutes(timeStr) {
  const parts = timeStr.split(":");
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1], 10);
  if (hh === 23 && mm === 59) {
    return 1440;
  }
  return hh * 60 + mm;
}

function SessionZoneMock() {
  return "GMT+7";
}

// =========================================================================
// ==================== BROWSER STORAGE MOCK BACKEND =======================
// =========================================================================
/**
 * Seeding mock database if running locally without GAS setup
 */
function initializeMockData() {
  if (!localStorage.getItem('mock_db_initialized')) {
    // Rooms
    const mockRooms = [];
    for (let r = 1; r <= 21; r++) {
      const pad = (r < 10) ? "0" + r : r;
      mockRooms.push({ id: `RM_${100+r}`, name: `Room ${pad}`, capacity: 5, description: `Live Room ${pad} equipped with HD Cam`, status: "Active" });
    }
    localStorage.setItem('mock_db_rooms', JSON.stringify(mockRooms));
    
    // Brands
    const mockBrands = [
      { id: "BR_101", name: "Foremost", status: "Active", owner: "admin" },
      { id: "BR_102", name: "Royal Canin", status: "Active", owner: "campaign1@company.com" },
      { id: "BR_103", name: "Club21", status: "Active", owner: "" },
      { id: "BR_104", name: "Evony", status: "Active", owner: "" },
      { id: "BR_105", name: "Subi", status: "Active", owner: "" },
      { id: "BR_106", name: "Bostanten", status: "Active", owner: "" },
      { id: "BR_107", name: "Glory", status: "Active", owner: "" },
      { id: "BR_108", name: "Hi-Q", status: "Active", owner: "" },
      { id: "BR_109", name: "Aristotle", status: "Active", owner: "" },
      { id: "BR_110", name: "TandT", status: "Active", owner: "" },
      { id: "BR_111", name: "Oceanglass", status: "Active", owner: "" },
      { id: "BR_112", name: "Kemissara", status: "Active", owner: "" },
      { id: "BR_113", name: "Babimild", status: "Active", owner: "" },
      { id: "BR_114", name: "Fineline", status: "Active", owner: "" },
      { id: "BR_115", name: "Fineline - AI", status: "Active", owner: "" },
      { id: "BR_116", name: "Big C", status: "Active", owner: "" },
      { id: "BR_117", name: "Dnee", status: "Active", owner: "" },
      { id: "BR_118", name: "Neo Beauty", status: "Active", owner: "" },
      { id: "BR_119", name: "Jabs-Beauty", status: "Active", owner: "" },
      { id: "BR_120", name: "Jabs-Tissue", status: "Active", owner: "" },
      { id: "BR_121", name: "Bio-Safety", status: "Active", owner: "" },
      { id: "BR_122", name: "DNEE FB+SHP", status: "Active", owner: "" },
      { id: "BR_123", name: "BetagroPet", status: "Active", owner: "" },
      { id: "BR_124", name: "Bonny bliss", status: "Active", owner: "" },
      { id: "BR_125", name: "BEO", status: "Active", owner: "" },
      { id: "BR_126", name: "Yassia", status: "Active", owner: "" },
      { id: "BR_127", name: "Taupe", status: "Active", owner: "" },
      { id: "BR_128", name: "Ichitan", status: "Active", owner: "" },
      { id: "BR_129", name: "Aldo", status: "Active", owner: "" },
      { id: "BR_130", name: "WakingBee", status: "Active", owner: "" },
      { id: "BR_131", name: "BabyLove", status: "Active", owner: "" }
    ];
    localStorage.setItem('mock_db_brands', JSON.stringify(mockBrands));
    
    // Users
    const mockUsers = [
      { email: "admin", name: "System Admin (Admin)", role: "Admin", status: "Active", password: "admin1234" },
      { email: "masteradmin", name: "Master Admin", role: "Master Admin", status: "Active", password: "Admin@1234" },
      { email: "admin.mock@company.com", name: "Aek Master Admin (Mock)", role: "Master Admin", status: "Active", password: "1234" },
      { email: "campaign1@company.com", name: "Film Campaign Manager", role: "Campaign Manager", status: "Active", password: "1234" },
      { email: "viewer@company.com", name: "Nina Viewer", role: "Viewer", status: "Active", password: "1234" },
    ];
    localStorage.setItem('mock_db_users', JSON.stringify(mockUsers));
    
    // Bookings
    const todayStr = getFormattedDate(new Date());
    const mockBookings = [
      {
        id: "BK_mock1",
        brandName: "Samsung",
        campaignName: "Galaxy S26 Launch Live",
        roomName: "Room 01",
        date: todayStr,
        startTime: "09:00",
        endTime: "12:00",
        remark: "ขอขาตั้งกล้องเพิ่ม 2 ตัว",
        ownerEmail: "campaign1@company.com",
        ownerName: "Film Campaign Manager",
        status: "Confirmed"
      },
      {
        id: "BK_mock2",
        brandName: "L'Oreal",
        campaignName: "L'Oreal Beauty Expo",
        roomName: "Room 03",
        date: todayStr,
        startTime: "10:00",
        endTime: "13:00",
        remark: "ต้องการไฟสีวอร์มไลต์",
        ownerEmail: "admin.mock@company.com",
        ownerName: "Aek Master Admin (Mock)",
        status: "Completed"
      },
      {
        id: "BK_mock3",
        brandName: "Apple",
        campaignName: "iPhone Live Clearance",
        roomName: "Room 02",
        date: todayStr,
        startTime: "13:00",
        endTime: "15:00",
        remark: "ไลฟ์เคลียร์สต็อกเครื่องโชว์",
        ownerEmail: "campaign1@company.com",
        ownerName: "Film Campaign Manager",
        status: "Confirmed"
      }
    ];
    localStorage.setItem('mock_db_bookings', JSON.stringify(mockBookings));
    
    // Logs
    const mockLogs = [
      { timestamp: "2026-06-23 10:15:30", userEmail: "campaign1@company.com", userName: "Film Campaign Manager", action: "CREATE_BOOKING", before: "-", after: "Room 01, Date today, 09:00-12:00, Samsung", ip: "127.0.0.1", device: "Chrome / macOS" },
      { timestamp: "2026-06-23 10:30:12", userEmail: "admin.mock@company.com", userName: "Aek Master Admin (Mock)", action: "CREATE_BOOKING", before: "-", after: "Room 03, Date today, 10:00-13:00, L'Oreal", ip: "127.0.0.1", device: "Chrome / macOS" },
    ];
    localStorage.setItem('mock_db_logs', JSON.stringify(mockLogs));
    
    // Master Password hash (SHA-256 for Admin@1234)
    localStorage.setItem('mock_master_password', "Admin@1234");
    
    localStorage.setItem('mock_db_initialized', 'true');
    localStorage.setItem('mock_db_brands_v2', 'true');
  }
  
  // Migration to update mock brands database to version 2 (with user's custom brand list)
  if (localStorage.getItem('mock_db_initialized') && !localStorage.getItem('mock_db_brands_v2')) {
    const mockBrands = [
      { id: "BR_101", name: "Foremost", status: "Active" },
      { id: "BR_102", name: "Royal Canin", status: "Active" },
      { id: "BR_103", name: "Club21", status: "Active" },
      { id: "BR_104", name: "Evony", status: "Active" },
      { id: "BR_105", name: "Subi", status: "Active" },
      { id: "BR_106", name: "Bostanten", status: "Active" },
      { id: "BR_107", name: "Glory", status: "Active" },
      { id: "BR_108", name: "Hi-Q", status: "Active" },
      { id: "BR_109", name: "Aristotle", status: "Active" },
      { id: "BR_110", name: "TandT", status: "Active" },
      { id: "BR_111", name: "Oceanglass", status: "Active" },
      { id: "BR_112", name: "Kemissara", status: "Active" },
      { id: "BR_113", name: "Babimild", status: "Active" },
      { id: "BR_114", name: "Fineline", status: "Active" },
      { id: "BR_115", name: "Fineline - AI", status: "Active" },
      { id: "BR_116", name: "Big C", status: "Active" },
      { id: "BR_117", name: "Dnee", status: "Active" },
      { id: "BR_118", name: "Neo Beauty", status: "Active" },
      { id: "BR_119", name: "Jabs-Beauty", status: "Active" },
      { id: "BR_120", name: "Jabs-Tissue", status: "Active" },
      { id: "BR_121", name: "Bio-Safety", status: "Active" },
      { id: "BR_122", name: "DNEE FB+SHP", status: "Active" },
      { id: "BR_123", name: "BetagroPet", status: "Active" },
      { id: "BR_124", name: "Bonny bliss", status: "Active" },
      { id: "BR_125", name: "BEO", status: "Active" },
      { id: "BR_126", name: "Yassia", status: "Active" },
      { id: "BR_127", name: "Taupe", status: "Active" },
      { id: "BR_128", name: "Ichitan", status: "Active" },
      { id: "BR_129", name: "Aldo", status: "Active" },
      { id: "BR_130", name: "WakingBee", status: "Active" },
      { id: "BR_131", name: "BabyLove", status: "Active" }
    ];
    localStorage.setItem('mock_db_brands', JSON.stringify(mockBrands));
    localStorage.setItem('mock_db_brands_v2', 'true');
  }
}

/**
 * Execute simulated backend transactions locally on localstorage arrays
 */
function executeMockCall(action, payload, callback) {
  setTimeout(() => {
    // If user has logged out in the meantime, ignore callback
    if (!state.authToken && action !== 'login') return;
    try {
      const getDB = (key) => JSON.parse(localStorage.getItem(`mock_db_${key}`) || '[]');
      const saveDB = (key, data) => localStorage.setItem(`mock_db_${key}`, JSON.stringify(data));
      
      switch (action) {
        case "getInitData":
          callback(null, {
            user: state.currentUser,
            rooms: getDB('rooms').filter(r => r.status === "Active"),
            brands: getDB('brands').filter(b => b.status === "Active")
          });
          break;
          
        case "getSystemSettings":
          callback(null, {
            lineChannelAccessToken: localStorage.getItem('mock_line_token') || "",
            lineDestinationId: localStorage.getItem('mock_line_dest') || "",
            lineNotificationsEnabled: localStorage.getItem('mock_line_enabled') === "true",
            frontendUrl: localStorage.getItem('mock_frontend_url') || ""
          });
          break;
          
        case "saveSystemSettings":
          localStorage.setItem('mock_line_token', payload.settings.lineChannelAccessToken || "");
          localStorage.setItem('mock_line_dest', payload.settings.lineDestinationId || "");
          localStorage.setItem('mock_line_enabled', payload.settings.lineNotificationsEnabled ? "true" : "false");
          localStorage.setItem('mock_frontend_url', payload.settings.frontendUrl || "");
          callback(null, { success: true, message: "บันทึกตั้งค่า LINE จำลองสำเร็จ" });
          break;
          
        case "getBookings":
          callback(null, {
            bookings: getDB('bookings').filter(b => b.date === payload.date),
            date: payload.date
          });
          break;
          
        case "getMyBookings":
          callback(null, {
            bookings: getDB('bookings').filter(b => b.ownerEmail.toLowerCase() === payload.ownerEmail || b.ownerEmail.toLowerCase() === state.currentUser.email.toLowerCase())
          });
          break;
          
        case "getAllBookings":
          callback(null, {
            bookings: getDB('bookings')
          });
          break;
          
        case "verifyMasterPassword":
          const pwd = localStorage.getItem('mock_master_password') || "Admin@1234";
          callback(null, { verified: (pwd === payload.password) });
          break;
          
        case "changeMasterPassword":
          const oldPwd = localStorage.getItem('mock_master_password') || "Admin@1234";
          if (oldPwd !== payload.oldPassword) {
            callback("รหัสผ่าน Master Password ปัจจุบันไม่ถูกต้อง", null);
          } else {
            localStorage.setItem('mock_master_password', payload.newPassword);
            logMockActivity("CHANGE_MASTER_PASSWORD", "-", "Master password updated locally", "127.0.0.1", "Mock Env");
            callback(null, { message: "เปลี่ยนรหัสผ่าน Master Password จำลองสำเร็จ" });
          }
          break;
          
        case "createBooking":
          const newB = payload.bookingData;
          let dbB = getDB('bookings');
          
          // Overlap check
          const conflict = dbB.some(x => 
            x.status !== "Cancelled" &&
            x.roomName === newB.roomName &&
            x.date === newB.date &&
            (parseTimeToMinutes(newB.startTime) < parseTimeToMinutes(x.endTime) && parseTimeToMinutes(newB.endTime) > parseTimeToMinutes(x.startTime))
          );
          
          if (conflict) {
            callback("ห้องนี้ถูกจองในช่วงเวลาดังกล่าวแล้ว (Mock Conflict Error)", null);
          } else {
            const bId = "BK_" + new Date().getTime();
            
            // Simulate Google Drive folder url generation in mock mode
            let mockFolderUrl = "https://drive.google.com/drive/folders/mock_folder_" + new Date().getTime();
            let mockArtworkLayout = newB.lsArtworkLayout || "";
            let mockArtworkList = [];
            if (mockArtworkLayout) {
              try {
                mockArtworkList = JSON.parse(mockArtworkLayout);
              } catch (e) {
                if (mockArtworkLayout.trim() !== "") {
                  mockArtworkList = [{ type: "Other", url: mockArtworkLayout.trim() }];
                }
              }
            }
            mockArtworkList.unshift({ type: "Google Drive", url: mockFolderUrl });
            mockArtworkLayout = JSON.stringify(mockArtworkList);
            
            const record = {
              id: bId,
              ...newB,
              lsArtworkLayout: mockArtworkLayout,
              ownerEmail: state.currentUser.email,
              ownerName: state.currentUser.name
            };
            dbB.push(record);
            saveDB('bookings', dbB);
            
            logMockActivity("CREATE_BOOKING", "-", `Room ${newB.roomName}, ${newB.startTime}-${newB.endTime}, Brand ${newB.brandName} (Auto-created Mock Google Drive Folder)`, newB.ip, newB.device);
            callback(null, { bookingId: bId });
          }
          break;
          
        case "updateBooking":
          const editB = payload.bookingData;
          let dbEditB = getDB('bookings');
          const idx = dbEditB.findIndex(x => x.id === payload.bookingId);
          if (idx === -1) {
            callback("ไม่พบข้อมูลการจอง", null);
            return;
          }
          
          const oldBRecord = dbEditB[idx];
          
          // Conflict validation (ignoring self)
          const editConflict = editB.status !== "Cancelled" && dbEditB.some(x => 
            x.id !== payload.bookingId &&
            x.status !== "Cancelled" &&
            x.roomName === editB.roomName &&
            x.date === editB.date &&
            (parseTimeToMinutes(editB.startTime) < parseTimeToMinutes(x.endTime) && parseTimeToMinutes(editB.endTime) > parseTimeToMinutes(x.startTime))
          );
          
          if (editConflict) {
            callback("ห้องนี้ถูกจองในช่วงเวลาดังกล่าวแล้ว (Mock Conflict Error)", null);
          } else {
            dbEditB[idx] = {
              ...oldBRecord,
              ...editB
            };
            saveDB('bookings', dbEditB);
            
            const beforeTxt = `Room ${oldBRecord.roomName}, ${oldBRecord.startTime}-${oldBRecord.endTime}, Status: ${oldBRecord.status}`;
            const afterTxt = `Room ${editB.roomName}, ${editB.startTime}-${editB.endTime}, Status: ${editB.status}`;
            
            logMockActivity("EDIT_BOOKING", beforeTxt, afterTxt, editB.ip, editB.device);
            callback(null, { success: true });
          }
          break;
          
        case "cancelBooking":
          let dbCancelB = getDB('bookings');
          const cancelIdx = dbCancelB.findIndex(x => x.id === payload.bookingId);
          if (cancelIdx === -1) {
            callback("ไม่พบการจอง", null);
            return;
          }
          const oldCancelRecord = dbCancelB[cancelIdx];
          dbCancelB[cancelIdx].status = "Cancelled";
          saveDB('bookings', dbCancelB);
          
          logMockActivity("DELETE_BOOKING", `Status: ${oldCancelRecord.status}`, "Status: Cancelled", "-", "-");
          callback(null, { success: true });
          break;
          
        case "getActivityLogs":
          const logsPwd = localStorage.getItem('mock_master_password') || "Admin@1234";
          if (logsPwd !== payload.password) {
            callback("รหัสผ่าน Master Password ผิดพลาด (Mock Admin Error)", null);
          } else {
            callback(null, { logs: getDB('logs') });
          }
          break;
          
        case "manageRooms":
          let dbRooms = getDB('rooms');
          if (payload.subAction === 'list') {
            callback(null, { rooms: dbRooms });
          } else if (payload.subAction === 'add') {
            const newRoom = payload.payload;
            newRoom.id = "RM_" + (dbRooms.length + 101);
            dbRooms.push(newRoom);
            saveDB('rooms', dbRooms);
            logMockActivity("ADD_ROOM", "-", `Room: ${newRoom.name}`, "-", "-");
            callback(null, { success: true });
          } else if (payload.subAction === 'edit') {
            const editRoom = payload.payload;
            const rmIdx = dbRooms.findIndex(x => x.id === editRoom.id);
            const oldRName = dbRooms[rmIdx].name;
            
            if (editRoom.status === "Inactive") {
              const mockBookings = getDB('bookings');
              const now = new Date();
              const todayStr = getFormattedDate(now);
              const currentMins = now.getHours() * 60 + now.getMinutes();
              const hasPending = mockBookings.some(b => {
                if (b.status !== 'Confirmed') return false;
                const isMatch = b.roomId ? (b.roomId === editRoom.id) : (b.roomName === oldRName);
                if (!isMatch) return false;
                if (b.date > todayStr) return true;
                if (b.date === todayStr) {
                  const endMins = parseTimeToMinutes(b.endTime);
                  if (endMins > currentMins) return true;
                }
                return false;
              });
              if (hasPending) {
                callback("ไม่สามารถปิดใช้งานห้องได้ (Inactive) เนื่องจากยังมีรอบไลฟ์ของห้องนี้รอค้างอยู่ (Mock Error)", null);
                return;
              }
            }
            
            dbRooms[rmIdx] = editRoom;
            saveDB('rooms', dbRooms);
            logMockActivity("EDIT_ROOM", `Name: ${oldRName}`, `Name: ${editRoom.name} (${editRoom.status})`, "-", "-");
            callback(null, { success: true });
          } else if (payload.subAction === 'delete') {
            const rmId = payload.payload.id;
            const rmIdx = dbRooms.findIndex(x => x.id === rmId);
            if (rmIdx !== -1) {
              const oldR = dbRooms[rmIdx];
              
              const mockBookings = getDB('bookings');
              const now = new Date();
              const todayStr = getFormattedDate(now);
              const currentMins = now.getHours() * 60 + now.getMinutes();
              const hasPending = mockBookings.some(b => {
                if (b.status !== 'Confirmed') return false;
                const isMatch = b.roomId ? (b.roomId === rmId) : (b.roomName === oldR.name);
                if (!isMatch) return false;
                if (b.date > todayStr) return true;
                if (b.date === todayStr) {
                  const endMins = parseTimeToMinutes(b.endTime);
                  if (endMins > currentMins) return true;
                }
                return false;
              });
              if (hasPending) {
                callback("ไม่สามารถลบห้องได้ เนื่องจากยังมีรอบไลฟ์ของห้องนี้รอค้างอยู่ (Mock Error)", null);
                return;
              }
              
              dbRooms.splice(rmIdx, 1);
              saveDB('rooms', dbRooms);
              logMockActivity("DELETE_ROOM", `Room: ${oldR.name}`, "-", "-", "-");
            }
            callback(null, { success: true });
          }
          break;
          
        case "manageBrands":
          let dbBrands = getDB('brands');
          if (payload.subAction === 'list') {
            callback(null, { brands: dbBrands });
          } else if (payload.subAction === 'add') {
            const newBrand = payload.payload;
            newBrand.id = "BR_" + (dbBrands.length + 101);
            dbBrands.push(newBrand);
            saveDB('brands', dbBrands);
            logMockActivity("ADD_BRAND", "-", `Brand: ${newBrand.name}`, "-", "-");
            callback(null, { success: true });
          } else if (payload.subAction === 'edit') {
            const editBrand = payload.payload;
            const brIdx = dbBrands.findIndex(x => x.id === editBrand.id);
            const oldBName = dbBrands[brIdx].name;
            dbBrands[brIdx] = editBrand;
            saveDB('brands', dbBrands);
            logMockActivity("EDIT_BRAND", `Name: ${oldBName}`, `Name: ${editBrand.name} (${editBrand.status})`, "-", "-");
            callback(null, { success: true });
          } else if (payload.subAction === 'delete') {
            const brId = payload.payload.id;
            const brIdx = dbBrands.findIndex(x => x.id === brId);
            if (brIdx !== -1) {
              const oldB = dbBrands[brIdx];
              dbBrands.splice(brIdx, 1);
              saveDB('brands', dbBrands);
              logMockActivity("DELETE_BRAND", `Brand: ${oldB.name}`, "-", "-", "-");
            }
            callback(null, { success: true });
          }
          break;
          
        case "manageUsers":
          let dbUsers = getDB('users');
          if (payload.subAction === 'list') {
            callback(null, { users: dbUsers });
          } else if (payload.subAction === 'add') {
            const newUser = payload.payload;
            dbUsers.push(newUser);
            saveDB('users', dbUsers);
            logMockActivity("ADD_USER", "-", `User: ${newUser.email} (${newUser.role})`, "-", "-");
            callback(null, { success: true });
          } else if (payload.subAction === 'edit') {
            const editUser = payload.payload;
            const usIdx = dbUsers.findIndex(x => x.email.toLowerCase() === editUser.email.toLowerCase());
            const oldRole = dbUsers[usIdx].role;
            dbUsers[usIdx] = editUser;
            saveDB('users', dbUsers);
            logMockActivity("EDIT_USER", `Role: ${oldRole}`, `Role: ${editUser.role} (${editUser.status})`, "-", "-");
            callback(null, { success: true });
          } else if (payload.subAction === 'delete') {
            const uEmail = payload.payload.email.toLowerCase();
            if (uEmail === state.currentUser.email.toLowerCase()) {
              callback("คุณไม่สามารถลบบัญชีผู้ใช้งานของตัวเองได้", null);
              return;
            }
            const usIdx = dbUsers.findIndex(x => x.email.toLowerCase() === uEmail);
            if (usIdx !== -1) {
              const oldU = dbUsers[usIdx];
              dbUsers.splice(usIdx, 1);
              saveDB('users', dbUsers);
              logMockActivity("DELETE_USER", `User: ${oldU.email}`, "-", "-", "-");
            }
            callback(null, { success: true });
          }
          break;
          
        case "manualBackup":
          logMockActivity("MANUAL_BACKUP", "-", "Created manual local DB snapshot", "-", "-");
          callback(null, { message: "สร้างประวัติสำรองข้อมูลจำลองบนเบราว์เซอร์แล้ว" });
          break;
          
        case "manualArchive":
          let archiveB = getDB('bookings');
          saveDB('bookings', []); // Clear bookings
          logMockActivity("YEARLY_ARCHIVE", "-", `Mock archived ${archiveB.length} bookings`, "-", "-");
          callback(null, { message: "คัดลอกประวัติย้อนหลังเรียบร้อยล้างตารางจองจำลองปีนี้แล้ว" });
          break;
          
        default:
          callback("Unknown Action", null);
      }
    } catch (e) {
      callback(e.message, null);
    }
  }, 300);
}

function logMockActivity(action, before, after, ip, device) {
  const getDB = (key) => JSON.parse(localStorage.getItem(`mock_db_${key}`) || '[]');
  const saveDB = (key, data) => localStorage.setItem(`mock_db_${key}`, JSON.stringify(data));
  
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  
  let dbLogs = getDB('logs');
  dbLogs.push({
    timestamp,
    userEmail: state.currentUser ? state.currentUser.email : "SYSTEM",
    userName: state.currentUser ? state.currentUser.name : "System Daemon",
    action,
    before,
    after,
    ip: ip || "-",
    device: device || "-"
  });
  saveDB('logs', dbLogs);
}

/**
 * Initialize Dark Mode preference on load
 */
function initDarkMode() {
  const theme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  const isDark = theme === 'dark' || (!theme && prefersDark);
  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

/**
 * Toggle Dark Mode theme
 */
function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  
  // Update icon inside the button
  const btn = document.getElementById('dark-mode-btn');
  if (btn) {
    btn.innerHTML = isDark 
      ? `<i data-lucide="sun" class="w-5 h-5"></i>` 
      : `<i data-lucide="moon" class="w-5 h-5"></i>`;
    lucide.createIcons();
  }
}

const THAI_DAY_NAMES = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];
const THAI_DAY_NAMES_SHORT = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const THAI_MONTH_NAMES = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const THAI_MONTH_NAMES_LONG = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const THAI_MONTH_NAMES_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/**
 * Load and render Monthly/Weekly/Daily Calendar View
 */
function loadCalendarView(isSilent = false) {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  
  // Sync switcher UI and header titles
  syncCalendarSwitcherUI();
  updateCalendarHeaderAndSubtitle();

  // Check if we have localStorage cached calendar bookings
  let hasCache = false;
  try {
    const cachedCalendarStr = localStorage.getItem('cached_calendar_bookings');
    if (cachedCalendarStr) {
      state.calendarBookings = JSON.parse(cachedCalendarStr);
      renderCalendarGrid();
      hasCache = true;
    }
  } catch (e) {
    console.error("Error reading calendar cache:", e);
  }

  const silentMode = isSilent || hasCache;

  if (!silentMode) {
    // Skeletons depending on mode
    if (state.calendarViewMode === 'month') {
      grid.className = "grid grid-cols-7 gap-2 min-h-[420px]";
      grid.innerHTML = Array.from({ length: 35 }, (_, i) =>
        `<div class="rounded-xl border border-slate-100 dark:border-slate-800 p-2" style="min-height:80px">
           <div class="sk-cell" style="width:24px;height:10px;margin-bottom:6px;animation-delay:${(i * 0.02).toFixed(2)}s"></div>
           ${i % 3 === 0 ? `<div class="sk-cell" style="width:80%;height:10px;animation-delay:${(i * 0.02 + 0.1).toFixed(2)}s"></div>` : ''}
         </div>`).join('');
    } else if (state.calendarViewMode === 'week') {
      grid.className = "grid grid-cols-1 md:grid-cols-7 gap-4 min-h-[400px]";
      grid.innerHTML = Array.from({ length: 7 }, (_, i) =>
        `<div class="rounded-xl border border-slate-100 dark:border-slate-800 p-3" style="min-height:180px">
           <div class="sk-cell" style="width:60px;height:12px;margin-bottom:12px"></div>
           <div class="sk-cell" style="width:105px;height:45px;margin-bottom:6px"></div>
           <div class="sk-cell" style="width:105px;height:45px"></div>
         </div>`).join('');
    } else if (state.calendarViewMode === 'day') {
      grid.className = "grid grid-cols-1 gap-4 max-w-3xl mx-auto py-2";
      grid.innerHTML = Array.from({ length: 3 }, (_, i) =>
        `<div class="rounded-xl border border-slate-100 dark:border-slate-800 p-4" style="min-height:100px">
           <div class="flex gap-4">
             <div class="sk-cell" style="width:100px;height:30px"></div>
             <div class="flex-grow">
               <div class="sk-cell" style="width:200px;height:14px;margin-bottom:8px"></div>
               <div class="sk-cell" style="width:120px;height:10px"></div>
             </div>
           </div>
         </div>`).join('');
    }
  }
  
  apiCall('getAllBookings', {}, (err, data) => {
    if (err) {
      showToast("ไม่สามารถดึงข้อมูลคิวจองปฏิทินได้: " + err, "error");
      return;
    }
    
    detectAndNotifyNewBookings(state.calendarBookings, data.bookings);
    state.calendarBookings = mergeServerBookings(state.calendarBookings, data.bookings);
    
    // Save to localStorage cache
    try {
      localStorage.setItem('cached_calendar_bookings', JSON.stringify(state.calendarBookings));
    } catch (e) {
      console.error("Error writing calendar cache:", e);
    }
    
    renderCalendarGrid();
  });
}

/**
 * Sync active calendar switcher tab styling
 */
function syncCalendarSwitcherUI() {
  const modes = ['month', 'week', 'day'];
  modes.forEach(m => {
    const btn = document.getElementById(`calendar-view-${m}-btn`);
    if (btn) {
      if (m === state.calendarViewMode) {
        btn.className = "px-3 py-1.5 rounded-md text-xs font-semibold transition-all bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm";
      } else {
        btn.className = "px-3 py-1.5 rounded-md text-xs font-semibold transition-all text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white";
      }
    }
  });
  
  const todayBtn = document.getElementById('calendar-today-btn');
  if (todayBtn) {
    if (state.calendarViewMode === 'month') todayBtn.innerText = "เดือนนี้";
    else if (state.calendarViewMode === 'week') todayBtn.innerText = "สัปดาห์นี้";
    else if (state.calendarViewMode === 'day') todayBtn.innerText = "วันนี้";
  }
}

/**
 * Update Calendar Header Text and Subtitle dynamically
 */
function updateCalendarHeaderAndSubtitle() {
  const headerText = document.getElementById('calendar-month-year-display');
  const subtitleText = document.getElementById('calendar-subtitle-display');
  if (!headerText) return;

  const date = state.calendarSelectedDate || new Date();
  
  if (state.calendarViewMode === 'month') {
    headerText.innerText = `${THAI_MONTH_NAMES[state.calendarMonth]} ${state.calendarYear + 543}`;
    if (subtitleText) {
      subtitleText.innerText = "ภาพรวมการจองแต่ละวันในมุมมองปฏิทินรายเดือน คลิกช่องเพื่อเปิดตารางเวลาวันนั้นๆ";
    }
  } else if (state.calendarViewMode === 'week') {
    const current = new Date(date);
    const day = current.getDay();
    
    const start = new Date(current);
    start.setDate(current.getDate() - day);
    
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    
    const startDay = start.getDate();
    const startMonth = THAI_MONTH_NAMES_SHORT[start.getMonth()];
    const startYear = start.getFullYear() + 543;
    
    const endDay = end.getDate();
    const endMonth = THAI_MONTH_NAMES_SHORT[end.getMonth()];
    const endYear = end.getFullYear() + 543;
    
    if (start.getFullYear() === end.getFullYear()) {
      if (start.getMonth() === end.getMonth()) {
        headerText.innerText = `สัปดาห์: ${startDay} - ${endDay} ${startMonth} ${startYear}`;
      } else {
        headerText.innerText = `สัปดาห์: ${startDay} ${startMonth} - ${endDay} ${endMonth} ${startYear}`;
      }
    } else {
      headerText.innerText = `สัปดาห์: ${startDay} ${startMonth} ${startYear} - ${endDay} ${endMonth} ${endYear}`;
    }
    
    if (subtitleText) {
      subtitleText.innerText = "ภาพรวมคิวงานการจองในรอบสัปดาห์ คลิกการจองเพื่อแก้ไข/ดูรายละเอียด";
    }
  } else if (state.calendarViewMode === 'day') {
    const current = new Date(date);
    const dayName = THAI_DAY_NAMES[current.getDay()];
    const dayNum = current.getDate();
    const monthName = THAI_MONTH_NAMES_LONG[current.getMonth()];
    const yearVal = current.getFullYear() + 543;
    
    headerText.innerText = `${dayName}ที่ ${dayNum} ${monthName} ${yearVal}`;
    if (subtitleText) {
      subtitleText.innerText = "ตารางคิวงานประจำวัน คลิกการจองเพื่อแก้ไข/ดูรายละเอียด หรือสลับไปดูตารางจองรวม";
    }
  }
}

/**
 * Set active calendar view mode
 */
function setCalendarViewMode(mode) {
  state.calendarViewMode = mode;
  
  // Sync button styling
  syncCalendarSwitcherUI();
  
  // Synchronize anchor date
  if (!state.calendarSelectedDate) {
    state.calendarSelectedDate = new Date();
  }
  
  // Force calendarYear/calendarMonth alignment
  const d = new Date(state.calendarSelectedDate);
  state.calendarMonth = d.getMonth();
  state.calendarYear = d.getFullYear();

  // Render
  renderCalendarGrid();
}

/**
 * Handle navigation in calendar (Month, Week, or Day shifts)
 */
function navigateCalendar(direction) {
  if (!state.calendarSelectedDate) {
    state.calendarSelectedDate = new Date();
  }

  if (state.calendarViewMode === 'month') {
    state.calendarMonth += direction;
    if (state.calendarMonth < 0) {
      state.calendarMonth = 11;
      state.calendarYear -= 1;
    } else if (state.calendarMonth > 11) {
      state.calendarMonth = 0;
      state.calendarYear += 1;
    }
    state.calendarSelectedDate = new Date(state.calendarYear, state.calendarMonth, 1);
  } else if (state.calendarViewMode === 'week') {
    const d = new Date(state.calendarSelectedDate);
    d.setDate(d.getDate() + (7 * direction));
    state.calendarSelectedDate = d;
    state.calendarMonth = d.getMonth();
    state.calendarYear = d.getFullYear();
  } else if (state.calendarViewMode === 'day') {
    const d = new Date(state.calendarSelectedDate);
    d.setDate(d.getDate() + direction);
    state.calendarSelectedDate = d;
    state.calendarMonth = d.getMonth();
    state.calendarYear = d.getFullYear();
  }
  
  updateCalendarHeaderAndSubtitle();
  renderCalendarGrid();
}

/**
 * Set calendar anchor to current date
 */
function navigateCalendarToday() {
  const today = new Date();
  state.calendarSelectedDate = today;
  state.calendarMonth = today.getMonth();
  state.calendarYear = today.getFullYear();
  
  updateCalendarHeaderAndSubtitle();
  renderCalendarGrid();
}

// Keep changeCalendarMonth and setCalendarToCurrentMonth for back-compatibility
function changeCalendarMonth(direction) {
  navigateCalendar(direction);
}
function setCalendarToCurrentMonth() {
  navigateCalendarToday();
}

/**
 * Render Calendar Grid Days (Selector routing based on view mode)
 */

function renderCalendarGrid() {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  
  updateCalendarHeaderAndSubtitle();
  
  if (state.calendarViewMode === 'month') {
    renderMonthView();
  } else if (state.calendarViewMode === 'week') {
    renderWeekView();
  } else if (state.calendarViewMode === 'day') {
    renderDayView();
  }
  
  lucide.createIcons();
}

/**
 * Render standard Month Grid
 */
function renderMonthView() {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  grid.innerHTML = "";
  
  // Show standard days header
  const daysHeader = document.getElementById('calendar-days-header');
  if (daysHeader) daysHeader.classList.remove('hidden');
  
  grid.className = "grid grid-cols-7 gap-2 min-h-[420px]";
  
  const year = state.calendarYear;
  const month = state.calendarMonth;
  
  // First day of the month
  const firstDay = new Date(year, month, 1);
  let startDayOfWeek = firstDay.getDay(); 
  
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();
  
  // 1. Render prev month padded days
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const prevDayVal = prevMonthDays - i;
    const prevMonthIdx = month === 0 ? 11 : month - 1;
    const prevYearIdx = month === 0 ? year - 1 : year;
    const dateStr = `${prevYearIdx}-${String(prevMonthIdx + 1).padStart(2, '0')}-${String(prevDayVal).padStart(2, '0')}`;
    grid.appendChild(createCalendarDayNode(prevDayVal, dateStr, true));
  }
  
  // 2. Render current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    grid.appendChild(createCalendarDayNode(d, dateStr, false));
  }
  
  // 3. Render next month padded days
  const totalCells = 42;
  const currentCellsCount = startDayOfWeek + daysInMonth;
  const nextMonthPadding = totalCells - currentCellsCount;
  
  for (let n = 1; n <= nextMonthPadding; n++) {
    const nextMonthIdx = month === 11 ? 0 : month + 1;
    const nextYearIdx = month === 11 ? year + 1 : year;
    const dateStr = `${nextYearIdx}-${String(nextMonthIdx + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    grid.appendChild(createCalendarDayNode(n, dateStr, true));
  }
}

/**
 * Helper to build calendar day node (for Month grid)
 */
function createCalendarDayNode(dayNum, dateStr, isOtherMonth) {
  const container = document.createElement('div');
  container.className = `calendar-day-box flex flex-col gap-1 p-2 ${isOtherMonth ? 'other-month' : ''}`;
  
  if (dateStr === state.selectedDate && !isOtherMonth) {
    container.classList.add('ring-2', 'ring-brand-500', 'z-10');
  }
  
  // Find bookings for this date (exclude Cancelled and apply filters)
  const dayBookings = state.calendarBookings.filter(b => {
    if (b.date !== dateStr || b.status === 'Cancelled') return false;
    if (state.filters.room && b.roomName !== state.filters.room) return false;
    if (state.filters.brand && b.brandName !== state.filters.brand) return false;
    if (state.filters.status && b.status !== state.filters.status) return false;
    return true;
  });
  
  // Day number label
  const numLabel = document.createElement('div');
  numLabel.className = "text-xs font-bold text-slate-500 self-end";
  numLabel.innerText = dayNum;
  
  // Highlight today's date
  const todayStr = getFormattedDate(new Date());
  if (dateStr === todayStr && !isOtherMonth) {
    numLabel.className = "text-xs font-bold bg-brand-500 text-white rounded-full w-5 h-5 flex items-center justify-center self-end shadow-sm shadow-brand-500/20";
  }
  
  container.appendChild(numLabel);
  
  // Render bookings snippet inside cell (desktop view)
  const maxBadges = 3;
  dayBookings.slice(0, maxBadges).forEach(b => {
    const badge = document.createElement('div');
    let colorClass = "bg-blue-50 text-blue-700 border border-blue-100";
    if (b.status === "Completed") {
      colorClass = "bg-emerald-50 text-emerald-700 border border-emerald-100";
    }
    badge.className = `calendar-badge hidden sm:block text-[9px] px-1.5 py-0.5 rounded truncate font-medium ${colorClass}`;
    badge.innerText = `[${b.startTime}] ${b.brandName}`;
    badge.title = `${b.startTime}-${b.endTime} | ${b.roomName} | ${b.brandName} - ${b.campaignName}`;
    container.appendChild(badge);
  });
  
  // Show "+X more" if bookings exceed limit (desktop view)
  if (dayBookings.length > maxBadges) {
    const more = document.createElement('div');
    more.className = "text-[9px] text-slate-400 font-bold mt-1 text-center hidden sm:block";
    more.innerText = `+อีก ${dayBookings.length - maxBadges} รายการ`;
    container.appendChild(more);
  }
  
  // Render dot indicators (mobile view)
  if (dayBookings.length > 0) {
    const dotsContainer = document.createElement('div');
    dotsContainer.className = "flex flex-wrap gap-0.5 justify-center sm:hidden mt-0.5";
    dayBookings.slice(0, 3).forEach(b => {
      const dot = document.createElement('span');
      let dotColor = "bg-blue-500";
      if (b.status === "Completed") {
        dotColor = "bg-emerald-500";
      }
      dot.className = `w-1.5 h-1.5 rounded-full ${dotColor}`;
      dotsContainer.appendChild(dot);
    });
    if (dayBookings.length > 3) {
      const plusDot = document.createElement('span');
      plusDot.className = "text-[8px] text-slate-400 font-bold leading-none -mt-1 ml-0.5";
      plusDot.innerText = "+";
      dotsContainer.appendChild(plusDot);
    }
    container.appendChild(dotsContainer);
  }
  
  // Click handler to redirect to Scheduler or sync selected Date
  container.onclick = () => {
    state.selectedDate = dateStr;
    const picker = document.getElementById('scheduler-date-picker');
    if (picker) {
      picker.value = dateStr;
    }
    // Also update calendarSelectedDate so other views keep sync if they switch modes later
    state.calendarSelectedDate = parseDateSafely(dateStr);
    
    // Manage visual selection states
    document.querySelectorAll('.calendar-day-box').forEach(box => {
      box.classList.remove('ring-2', 'ring-brand-500', 'z-10');
    });
    container.classList.add('ring-2', 'ring-brand-500', 'z-10');
    if (hasTabPermission('scheduler')) {
      switchTab('scheduler');
    }
  };
  
  return container;
}

/**
 * Render Weekly Columns View
 */
function renderWeekView() {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  
  // Hide standard days header
  const daysHeader = document.getElementById('calendar-days-header');
  if (daysHeader) daysHeader.classList.add('hidden');
  
  grid.className = "grid grid-cols-1 md:grid-cols-7 gap-4 min-h-[400px]";
  grid.innerHTML = "";
  
  const dates = getWeekDates(state.calendarSelectedDate || new Date());
  const todayStr = getFormattedDate(new Date());
  
  dates.forEach(d => {
    const dateStr = getFormattedDate(d);
    const dayOfWeek = d.getDay();
    const dayName = THAI_DAY_NAMES_SHORT[dayOfWeek];
    const isToday = dateStr === todayStr;
    
    // Find bookings for this day (exclude Cancelled and apply filters)
    const dayBookings = state.calendarBookings.filter(b => {
      if (b.date !== dateStr || b.status === 'Cancelled') return false;
      if (state.filters.room && b.roomName !== state.filters.room) return false;
      if (state.filters.brand && b.brandName !== state.filters.brand) return false;
      if (state.filters.status && b.status !== state.filters.status) return false;
      return true;
    });
    
    // Sort bookings by start time
    dayBookings.sort((a, b) => a.startTime.localeCompare(b.startTime));
    
    // Create column card
    const colCard = document.createElement('div');
    colCard.className = `flex flex-col gap-3 p-3 rounded-xl border ${isToday ? 'border-brand-500 bg-brand-50/10 dark:bg-brand-900/10 shadow-sm' : 'border-slate-200 dark:border-slate-700 bg-slate-50/30 dark:bg-slate-800/10'} transition-all min-h-[180px]`;
    
    // Column Header
    const colHeader = document.createElement('div');
    colHeader.className = "flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2";
    
    // Day Label (e.g. จ. 22)
    const dayLabel = document.createElement('div');
    dayLabel.className = "flex items-center gap-1.5 font-bold text-xs";
    
    let colorClass = "text-slate-750 dark:text-slate-355";
    if (dayOfWeek === 0) colorClass = "text-rose-600 dark:text-rose-450";
    else if (dayOfWeek === 6) colorClass = "text-blue-600 dark:text-blue-450";
    if (isToday) colorClass = "text-brand-650 dark:text-brand-400 font-extrabold";
    
    dayLabel.innerHTML = `
      <span class="md:hidden ${colorClass}">${THAI_DAY_NAMES[dayOfWeek]}ที่ ${d.getDate()} ${THAI_MONTH_NAMES_SHORT[d.getMonth()]}</span>
      <span class="hidden md:inline ${colorClass}">${dayName} ${d.getDate()}</span>
    `;
    dayLabel.style.lineHeight = "1";
    
    colHeader.appendChild(dayLabel);
    
    // Today Badge if applicable
    if (isToday) {
      const todayBadge = document.createElement('span');
      todayBadge.className = "px-1.5 py-0.5 bg-brand-500 text-white text-[9px] font-bold rounded-full shadow-sm";
      todayBadge.innerText = "วันนี้";
      colHeader.appendChild(todayBadge);
    } else {
      if (dayBookings.length > 0) {
        const countBadge = document.createElement('span');
        countBadge.className = "px-1.5 py-0.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-[9px] font-semibold rounded-full";
        countBadge.innerText = `${dayBookings.length} คิว`;
        colHeader.appendChild(countBadge);
      }
    }
    
    colCard.appendChild(colHeader);
    
    // Bookings Area
    const bookingsArea = document.createElement('div');
    bookingsArea.className = "flex flex-col gap-2 flex-grow overflow-y-auto max-h-[300px] pr-0.5";
    
    if (dayBookings.length === 0) {
      const noBookings = document.createElement('div');
      noBookings.className = "flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-750 rounded-lg p-4 text-center text-[10px] text-slate-400 dark:text-slate-600 flex-grow min-h-[80px]";
      noBookings.innerHTML = `
        <i data-lucide="calendar-range" class="w-4 h-4 mb-1 text-slate-300 dark:text-slate-700"></i>
        <span>ไม่มีคิวงาน</span>
      `;
      bookingsArea.appendChild(noBookings);
    } else {
      dayBookings.forEach(b => {
        bookingsArea.appendChild(createBookingCard(b));
      });
    }
    
    colCard.appendChild(bookingsArea);
    
    // Allow clicking the empty part of column card to navigate to Daily Scheduler
    colCard.addEventListener('click', (e) => {
      if (e.target.closest('.booking-item-card')) return;
      state.selectedDate = dateStr;
      const picker = document.getElementById('scheduler-date-picker');
      if (picker) picker.value = dateStr;
      if (hasTabPermission('scheduler')) {
        switchTab('scheduler');
      }
    });
    colCard.style.cursor = 'pointer';
    
    grid.appendChild(colCard);
  });
  
  // Re-initialize dynamic Lucide icons for Week columns and booking cards
  lucide.createIcons();
}

/**
 * Render Daily Focused View
 */
function renderDayView() {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  
  // Hide standard days header
  const daysHeader = document.getElementById('calendar-days-header');
  if (daysHeader) daysHeader.classList.add('hidden');
  
  grid.className = "grid grid-cols-1 gap-4 max-w-3xl mx-auto py-2";
  grid.innerHTML = "";
  
  const dateStr = getFormattedDate(state.calendarSelectedDate || new Date());
  const dayBookings = state.calendarBookings.filter(b => {
    if (b.date !== dateStr || b.status === 'Cancelled') return false;
    if (state.filters.room && b.roomName !== state.filters.room) return false;
    if (state.filters.brand && b.brandName !== state.filters.brand) return false;
    if (state.filters.status && b.status !== state.filters.status) return false;
    return true;
  });
  
  // Sort chronologically
  dayBookings.sort((a, b) => a.startTime.localeCompare(b.startTime));
  
  if (dayBookings.length === 0) {
    const noBookings = document.createElement('div');
    noBookings.className = "flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-750 rounded-2xl p-12 text-center bg-slate-50/20 dark:bg-slate-800/10 min-h-[300px] animate-in fade-in duration-300";
    noBookings.innerHTML = `
      <div class="p-4 bg-slate-100 dark:bg-slate-800 rounded-full mb-3 text-slate-400">
        <i data-lucide="calendar-x" class="w-8 h-8 text-slate-350 dark:text-slate-650"></i>
      </div>
      <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">ไม่มีคิวจองสำหรับวันที่เลือก</h3>
      <p class="text-xs text-slate-400 max-w-xs mb-4">คุณสามารถกดสลับไปที่หน้าจองรวมหรือคลิกที่ปุ่มด้านล่างเพื่อเพิ่มการจองใหม่ในวันที่เลือกนี้ได้ทันที</p>
      <button onclick="openBookingModalForDate('${dateStr}')" class="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-semibold shadow-md shadow-brand-500/20 transition-all flex items-center gap-1.5">
        <i data-lucide="plus" class="w-4 h-4"></i> เพิ่มคิวจองวันนี้
      </button>
    `;
    grid.appendChild(noBookings);
    lucide.createIcons();
    return;
  }
  
  dayBookings.forEach(b => {
    const card = document.createElement('div');
    card.className = "booking-day-row flex flex-col md:flex-row gap-4 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 duration-300";
    
    // Status color configurations
    let borderClass = "border-l-blue-500 dark:border-l-blue-500";
    let statusText = "อนุมัติแล้ว";
    let statusBadgeColor = "bg-blue-50/60 text-blue-700 border-blue-100 dark:bg-blue-950/20 dark:text-blue-350 dark:border-blue-900/50";
    let statusDot = "bg-blue-500";
    
    if (b.status === "Pending") {
      borderClass = "border-l-amber-500 dark:border-l-amber-500";
      statusText = "รอดำเนินการ";
      statusBadgeColor = "bg-amber-50/60 text-amber-700 border-amber-100 dark:bg-amber-950/20 dark:text-amber-350 dark:border-amber-900/50";
      statusDot = "bg-amber-500";
    } else if (b.status === "Completed") {
      borderClass = "border-l-emerald-500 dark:border-l-emerald-500";
      statusText = "เสร็จสิ้น";
      statusBadgeColor = "bg-emerald-50/60 text-emerald-700 border-emerald-100 dark:bg-emerald-950/20 dark:text-emerald-350 dark:border-emerald-900/50";
      statusDot = "bg-emerald-500";
    }
    
    card.className += ` border-l-4 ${borderClass}`;
    
    // Left: Time block
    const timeLeft = document.createElement('div');
    timeLeft.className = "flex md:flex-col justify-between md:justify-center md:items-start shrink-0 pb-3 md:pb-0 md:pr-5 border-b md:border-b-0 md:border-r border-slate-100 dark:border-slate-805 min-w-[150px] gap-2";
    timeLeft.innerHTML = `
      <div class="flex flex-col gap-0.5">
        <span class="text-[9px] uppercase font-bold text-slate-400 dark:text-slate-500 tracking-wider">ช่วงเวลาไลฟ์</span>
        <div class="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-base">
          <i data-lucide="clock" class="w-4 h-4 text-slate-400 dark:text-slate-500"></i>
          <span>${b.startTime} - ${b.endTime} น.</span>
        </div>
      </div>
      <div class="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-850 px-2 py-1 rounded-lg border border-slate-100 dark:border-slate-800/50 self-start">
        <i data-lucide="hourglass" class="w-3 h-3 text-slate-400"></i>
        <span>ระยะเวลา: ${calculateDuration(b.startTime, b.endTime)}</span>
      </div>
    `;
    card.appendChild(timeLeft);
    
    // Middle: Content block
    const contentMid = document.createElement('div');
    contentMid.className = "flex-1 flex flex-col gap-2 text-left justify-center";
    
    contentMid.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">${b.campaignName}</h3>
        <span class="inline-flex items-center gap-1 px-2.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-300 text-[10px] font-bold rounded-full border border-slate-200 dark:border-slate-700">
          <i data-lucide="video" class="w-3 h-3 text-slate-500"></i>
          <span>${b.roomName}</span>
        </span>
      </div>
      
      <div class="flex flex-wrap items-center gap-y-1 gap-x-4 text-xs text-slate-500 dark:text-slate-455">
        <div class="flex items-center gap-1.5">
          <i data-lucide="award" class="w-3.5 h-3.5 text-slate-400"></i>
          <span>ลูกค้า/แบรนด์: <span class="font-bold text-slate-800 dark:text-slate-200">${b.brandName}</span></span>
        </div>
      </div>
    `;
    
    if (b.ownerName || b.ownerEmail) {
      const displayOwner = b.ownerName ? `${b.ownerName} (${b.ownerEmail})` : b.ownerEmail;
      contentMid.innerHTML += `
        <div class="text-[10px] text-slate-455 dark:text-slate-500 flex items-center gap-1.5">
          <i data-lucide="user" class="w-3.5 h-3.5 text-slate-350 dark:text-slate-650"></i>
          <span>ผู้สร้างจอง: <span class="font-medium text-slate-550 dark:text-slate-450">${displayOwner}</span></span>
        </div>`;
    }
    
    // Drive links
    const artworkList = getArtworkLinks(b.lsArtworkLayout);
    if (artworkList.length > 0) {
      const artContainer = document.createElement('div');
      artContainer.className = "flex flex-wrap gap-1.5 mt-1";
      artworkList.forEach(art => {
        const link = document.createElement('a');
        link.href = art.url;
        link.target = "_blank";
        link.className = "px-2.5 py-1 bg-brand-50 hover:bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-350 dark:hover:bg-brand-900/30 text-[10px] font-bold rounded-lg border border-brand-100 dark:border-brand-900/30 transition-all flex items-center gap-1.5 shadow-sm";
        
        let iconName = "link";
        if (art.type === "Google Drive" || art.url.includes("drive.google.com")) {
          iconName = "folder-open";
        }
        link.innerHTML = `<i data-lucide="${iconName}" class="w-3 h-3"></i> ${art.type || 'ลิงก์เสริม'}`;
        artContainer.appendChild(link);
      });
      contentMid.appendChild(artContainer);
    }
    
    card.appendChild(contentMid);
    
    // Right: Actions & Status
    const rightActions = document.createElement('div');
    rightActions.className = "flex md:flex-col items-end justify-between md:justify-center shrink-0 gap-3.5 border-t md:border-t-0 md:border-l border-slate-100 dark:border-slate-800 pt-3 md:pt-0 md:pl-5 min-w-[130px]";
    
    const badge = document.createElement('span');
    badge.className = `inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-extrabold rounded-full border ${statusBadgeColor}`;
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${statusDot}"></span> ${statusText}`;
    rightActions.appendChild(badge);
    
    const btnGroup = document.createElement('div');
    btnGroup.className = "flex items-center gap-1.5";
    
    const userRole = getUserRole();
    const canCreate = (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canCreateBooking) || userRole === 'master admin';
    const canEdit = (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canEditBooking) || userRole === 'master admin';
    const isOwner = String(b.ownerEmail || '').toLowerCase() === String(state.currentUser.email || '').toLowerCase();
    const hasEditAccess = canEdit || isOwner;
    
    if (canCreate) {
      const dupBtn = document.createElement('button');
      dupBtn.className = "p-1.5 bg-slate-50 hover:bg-slate-100 dark:bg-slate-850 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-355 rounded-xl border border-slate-200 dark:border-slate-700 transition-all";
      dupBtn.title = "ทำซ้ำรายการจอง";
      dupBtn.innerHTML = `<i data-lucide="copy" class="w-4 h-4"></i>`;
      dupBtn.onclick = (e) => {
        e.stopPropagation();
        duplicateBooking(b.id);
      };
      btnGroup.appendChild(dupBtn);
    }
    
    const editBtn = document.createElement('button');
    if (hasEditAccess) {
      editBtn.className = "px-3.5 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-semibold shadow-sm shadow-brand-500/10 hover:shadow-md hover:shadow-brand-500/25 transition-all flex items-center gap-1.5";
      editBtn.innerHTML = `<i data-lucide="edit-3" class="w-4 h-4"></i> แก้ไข`;
    } else {
      editBtn.className = "px-3.5 py-1.5 bg-slate-50 hover:bg-slate-100 dark:bg-slate-850 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-semibold border border-slate-200 dark:border-slate-700 transition-all flex items-center gap-1.5";
      editBtn.title = "ดูรายละเอียดการจอง";
      editBtn.innerHTML = `<i data-lucide="eye" class="w-4 h-4"></i> รายละเอียด`;
    }
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openBookingEditModal(b.id);
    };
    btnGroup.appendChild(editBtn);
    
    rightActions.appendChild(btnGroup);
    card.appendChild(rightActions);
    
    grid.appendChild(card);
  });
  
  // Re-initialize dynamic Lucide icons for Day view booking cards
  lucide.createIcons();
}

/**
 * Helper to build custom booking cards in Week/Day views
 */
function createBookingCard(b) {
  const card = document.createElement('div');
  card.className = "booking-item-card flex flex-col p-2.5 rounded-lg border-l-4 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer bg-white dark:bg-slate-800 text-left border border-slate-200/60 dark:border-slate-700/50";
  
  let borderClass = "border-l-blue-500 dark:border-l-blue-450";
  let bgHoverClass = "hover:bg-blue-50/10 dark:hover:bg-blue-900/5";
  let statusText = "อนุมัติแล้ว";
  let statusBadgeColor = "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800";
  
  if (b.status === "Pending") {
    borderClass = "border-l-amber-500 dark:border-l-amber-450";
    bgHoverClass = "hover:bg-amber-50/10 dark:hover:bg-amber-900/5";
    statusText = "รอดำเนินการ";
    statusBadgeColor = "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800";
  } else if (b.status === "Completed") {
    borderClass = "border-l-emerald-500 dark:border-l-emerald-450";
    bgHoverClass = "hover:bg-emerald-50/10 dark:hover:bg-emerald-900/5";
    statusText = "เสร็จสิ้น";
    statusBadgeColor = "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800";
  }
  
  card.className += ` ${borderClass} ${bgHoverClass}`;
  
  const topRow = document.createElement('div');
  topRow.className = "flex items-center justify-between gap-1.5 mb-1";
  
  const timeInfo = document.createElement('span');
  timeInfo.className = "text-[10px] font-bold text-slate-750 dark:text-slate-200 flex items-center gap-1 shrink-0";
  timeInfo.innerHTML = `<i data-lucide="clock" class="w-3 h-3 text-slate-400"></i> ${b.startTime} - ${b.endTime}`;
  
  const roomBadge = document.createElement('span');
  roomBadge.className = "px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-650 dark:text-slate-350 text-[8px] font-bold rounded truncate max-w-[65px] border border-slate-200/50 dark:border-slate-600/40";
  roomBadge.innerText = b.roomName;
  roomBadge.title = b.roomName;
  
  topRow.appendChild(timeInfo);
  topRow.appendChild(roomBadge);
  card.appendChild(topRow);
  
  const campaignInfo = document.createElement('div');
  campaignInfo.className = "text-[11px] font-bold text-slate-900 dark:text-white truncate leading-snug";
  campaignInfo.innerText = b.campaignName;
  campaignInfo.title = b.campaignName;
  card.appendChild(campaignInfo);
  
  const brandInfo = document.createElement('div');
  brandInfo.className = "text-[9.5px] text-slate-400 dark:text-slate-500 font-medium truncate mb-1";
  brandInfo.innerText = b.brandName;
  card.appendChild(brandInfo);
  
  const bottomRow = document.createElement('div');
  bottomRow.className = "flex items-center justify-between mt-1 pt-1 border-t border-slate-100 dark:border-slate-850";
  
  const statusBadge = document.createElement('span');
  statusBadge.className = `px-1 py-0.2 text-[8px] font-bold rounded border ${statusBadgeColor}`;
  statusBadge.innerText = statusText;
  
  const editBtn = document.createElement('span');
  const userRole = getUserRole();
  const canEdit = (state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canEditBooking) || userRole === 'master admin';
  const isOwner = String(b.ownerEmail || '').toLowerCase() === String(state.currentUser.email || '').toLowerCase();
  const hasEditAccess = canEdit || isOwner;
  
  if (hasEditAccess) {
    editBtn.className = "text-[9px] font-semibold text-brand-650 dark:text-brand-400 hover:underline flex items-center gap-0.5 shrink-0";
    editBtn.innerHTML = `<i data-lucide="edit-3" class="w-2.5 h-2.5"></i> แก้ไข`;
  } else {
    editBtn.className = "text-[9px] font-semibold text-slate-500 hover:underline flex items-center gap-0.5 shrink-0";
    editBtn.innerHTML = `<i data-lucide="eye" class="w-2.5 h-2.5"></i> รายละเอียด`;
  }
  
  bottomRow.appendChild(statusBadge);
  bottomRow.appendChild(editBtn);
  card.appendChild(bottomRow);
  
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    openBookingEditModal(b.id);
  });
  
  return card;
}

/**
 * Helper to get dates for a given week containing the anchor date
 */
function getWeekDates(date) {
  const current = new Date(date);
  const day = current.getDay();
  const start = new Date(current);
  start.setDate(current.getDate() - day);
  
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(d);
  }
  return dates;
}

/**
 * Parse artwork layout list safely
 */
function getArtworkLinks(lsArtworkLayout) {
  if (!lsArtworkLayout) return [];
  try {
    const parsed = JSON.parse(lsArtworkLayout);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    if (typeof lsArtworkLayout === 'string' && lsArtworkLayout.trim() !== '') {
      return [{ type: 'Other', url: lsArtworkLayout.trim() }];
    }
  }
  return [];
}

/**
 * Calculate human-readable duration between times
 */
function calculateDuration(start, end) {
  try {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff <= 0) return "-";
    const hrs = Math.floor(diff / 60);
    const mins = diff % 60;
    if (hrs > 0 && mins > 0) return `${hrs} ชม. ${mins} น.`;
    if (hrs > 0) return `${hrs} ชม.`;
    return `${mins} นาที`;
  } catch (e) {
    return "-";
  }
}

/**
 * Open create booking modal pre-set with a target date
 */
function openBookingModalForDate(dateStr) {
  openBookingModal();
  const dateInput = document.getElementById('booking-form-date');
  if (dateInput) {
    dateInput.value = dateStr;
  }
}

/**
 * Load and render Analytics Dashboard data
 */
function loadAnalyticsView(isSilent = false) {
  const utilContainer = document.getElementById('analytics-room-utilization');
  const leadContainer = document.getElementById('analytics-brand-leaderboard');
  const peakContainer = document.getElementById('analytics-peak-hours');
  
  if (!utilContainer || !leadContainer || !peakContainer) return;
  
  // Sync date picker values
  let startDateVal = state.analyticsStartDate;
  let endDateVal = state.analyticsEndDate;
  
  if (!startDateVal || !endDateVal) {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    startDateVal = getFormattedDate(firstDay);
    endDateVal = getFormattedDate(lastDay);
    
    state.analyticsStartDate = startDateVal;
    state.analyticsEndDate = endDateVal;
  }
  
  const startInput = document.getElementById('analytics-start-date');
  const endInput = document.getElementById('analytics-end-date');
  if (startInput) startInput.value = startDateVal;
  if (endInput) endInput.value = endDateVal;
  
  if (!isSilent) {
    const loadingHtml = `<div class="flex justify-center items-center py-10 w-full"><div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500"></div></div>`;
    utilContainer.innerHTML = loadingHtml;
    leadContainer.innerHTML = loadingHtml;
    peakContainer.innerHTML = `<div class="col-span-24 flex justify-center items-center py-10 w-full"><div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div></div>`;
  }
  
  apiCall('getAllBookings', {}, (err, data) => {
    if (err) {
      showToast("ไม่สามารถเรียกดูข้อมูลสถิติได้: " + err, "error");
      return;
    }
    
    // Update shared calendarBookings cache
    state.calendarBookings = mergeServerBookings(state.calendarBookings, data.bookings);
    try {
      localStorage.setItem('cached_calendar_bookings', JSON.stringify(state.calendarBookings));
    } catch (e) {
      console.error("Error writing calendar cache in analytics:", e);
    }
    
    let bookings = data.bookings.filter(b => b.status !== "Cancelled");
    
    // Apply custom date range filters
    if (startDateVal) {
      bookings = bookings.filter(b => b.date >= startDateVal);
    }
    if (endDateVal) {
      bookings = bookings.filter(b => b.date <= endDateVal);
    }
    
    // 1. Calculate Room Utilization
    renderRoomUtilization(bookings);
    
    // 2. Calculate Brand Leaderboard
    renderBrandLeaderboard(bookings);
    
    // 3. Calculate Peak Hours
    renderPeakHours(bookings);
    
    // Load icons
    lucide.createIcons();

    if (!isSilent) {
      showToast("รีเฟรชข้อมูลสถิติเรียบร้อยแล้ว", "success");
    }
  });
}

/**
 * Handle analytics date range changes
 */
function handleAnalyticsDateChange() {
  const startDateStr = document.getElementById('analytics-start-date').value;
  const endDateStr = document.getElementById('analytics-end-date').value;
  
  state.analyticsStartDate = startDateStr;
  state.analyticsEndDate = endDateStr;
  
  loadAnalyticsView(false); // Reload and render
}

/**
 * Render Room Utilization horizontal bars
 */
function renderRoomUtilization(bookings) {
  const container = document.getElementById('analytics-room-utilization');
  if (!container) return;
  
  // Get all active rooms from state
  const rooms = state.rooms.length > 0 ? state.rooms : [
    { name: "Room 01" }, { name: "Room 02" }, { name: "Room 03" }, { name: "Room 04" }, { name: "Room 05" }, { name: "Room 06" }
  ];
  
  const roomStats = rooms.map(r => {
    const count = bookings.filter(b => b.roomName === r.name).length;
    return { name: r.name, count };
  }).filter(r => r.count > 0);
  
  if (roomStats.length === 0) {
    container.innerHTML = `<div class="text-center py-8 text-xs text-slate-450 dark:text-slate-500">ไม่มีข้อมูลอัตราการใช้งานห้องในช่วงเวลานี้</div>`;
    return;
  }
  
  // Sort room stats by count descending
  roomStats.sort((a, b) => b.count - a.count);
  
  const maxCount = Math.max(...roomStats.map(r => r.count), 1);
  
  container.innerHTML = "";
  roomStats.forEach(r => {
    const pct = Math.round((r.count / maxCount) * 100);
    container.innerHTML += `
      <div class="flex flex-col gap-1.5">
        <div class="flex justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
          <span class="flex items-center gap-1.5"><i data-lucide="video" class="w-3.5 h-3.5 text-slate-400"></i> ${r.name}</span>
          <span class="font-bold text-slate-900 dark:text-slate-100">${r.count} รายการจอง (${pct}%)</span>
        </div>
        <div class="w-full bg-slate-100 dark:bg-slate-750 h-3 rounded-full overflow-hidden">
          <div class="bg-brand-500 h-full rounded-full transition-all duration-500" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  });
}

/**
 * Render Brand Leaderboard (Top Brands by Booked Hours)
 */
function renderBrandLeaderboard(bookings) {
  const container = document.getElementById('analytics-brand-leaderboard');
  if (!container) return;
  
  const brandDurations = {};
  
  bookings.forEach(b => {
    const startMins = parseTimeToMinutes(b.startTime);
    const endMins = parseTimeToMinutes(b.endTime);
    if (endMins > startMins) {
      const durationHours = (endMins - startMins) / 60;
      brandDurations[b.brandName] = (brandDurations[b.brandName] || 0) + durationHours;
    }
  });
  
  // Convert map to array and sort descending
  const leaders = Object.keys(brandDurations).map(name => ({
    name,
    hours: brandDurations[name]
  })).sort((a, b) => b.hours - a.hours);
  
  const topLeaders = leaders.slice(0, 5);
  
  container.innerHTML = "";
  if (topLeaders.length === 0) {
    container.innerHTML = `<div class="text-center py-6 text-xs text-slate-400">ไม่พบสถิติแบรนด์ในระบบ</div>`;
    return;
  }
  
  topLeaders.forEach((l, idx) => {
    let medalBg = "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300";
    if (idx === 0) medalBg = "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400";
    if (idx === 1) medalBg = "bg-slate-200 text-slate-800 dark:bg-slate-700/60 dark:text-slate-300";
    if (idx === 2) medalBg = "bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-400";
    
    container.innerHTML += `
      <div class="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all">
        <div class="flex items-center gap-3">
          <span class="w-6 h-6 flex items-center justify-center ${medalBg} text-xs font-bold rounded-full">${idx + 1}</span>
          <span class="text-sm font-semibold text-slate-800 dark:text-slate-200">${l.name}</span>
        </div>
        <span class="text-xs font-bold text-brand-600 dark:text-brand-400">${l.hours.toFixed(1)} ชม.</span>
      </div>
    `;
  });
}

/**
 * Render Peak Live Hours vertical bar charts
 */
function renderPeakHours(bookings) {
  const container = document.getElementById('analytics-peak-hours');
  if (!container) return;
  
  // Grid 7 days (0: Sun to 6: Sat) x 24 hours (0 to 23)
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  
  bookings.forEach(b => {
    const dateObj = parseDateSafely(b.date);
    const day = dateObj.getDay(); // 0 is Sun, 1 is Mon...
    
    const startHour = Math.floor(parseTimeToMinutes(b.startTime) / 60);
    const endHour = Math.ceil(parseTimeToMinutes(b.endTime) / 60);
    
    for (let h = startHour; h < endHour; h++) {
      if (h >= 0 && h < 24) {
        grid[day][h]++;
      }
    }
  });
  
  const maxCount = Math.max(...grid.map(row => Math.max(...row)), 1);
  
  const dayNames = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];
  const dayAbbrs = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
  
  let html = "";
  
  // 1. Render Hours Label Header (00 to 23)
  html += `
    <div class="flex items-center gap-1.5 mb-1.5">
      <div class="w-14 text-right pr-2 text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase">เวลา</div>
      <div class="flex-grow grid grid-cols-24 gap-1">
  `;
  for (let h = 0; h < 24; h++) {
    html += `<div class="text-[9px] font-bold text-slate-400 dark:text-slate-500 text-center">${String(h).padStart(2, '0')}</div>`;
  }
  html += `
      </div>
    </div>
  `;
  
  // 2. Render each day row
  for (let d = 0; d < 7; d++) {
    html += `
      <div class="flex items-center gap-1.5">
        <div class="w-14 text-right pr-2 font-semibold text-slate-500 dark:text-slate-450 text-[10px] truncate" title="${dayNames[d]}">${dayAbbrs[d]}</div>
        <div class="flex-grow grid grid-cols-24 gap-1">
    `;
    
    for (let h = 0; h < 24; h++) {
      const count = grid[d][h];
      const ratio = count / maxCount;
      
      let bgStyle = "";
      let borderClass = "border border-slate-100/50 dark:border-slate-800/20";
      
      if (count === 0) {
        bgStyle = ""; // Default class handles transparent/empty slot
      } else {
        // Indigo tint: Brand rgb(59, 130, 246)
        bgStyle = `style="background-color: rgba(59, 130, 246, ${0.15 + ratio * 0.85})"`;
        borderClass = "border border-blue-500/25";
      }
      
      const tooltipText = `
        ${dayNames[d]} เวลา ${String(h).padStart(2, '0')}:00 - ${String(h+1).padStart(2, '0')}:00 น.<br>
        <span class="font-bold text-emerald-400">${count} คิวจอง</span>
      `;
      
      html += `
        <div class="heatmap-cell h-6 rounded-md transition-all duration-300 ${count === 0 ? 'bg-slate-50 dark:bg-slate-800/40' : ''} ${borderClass}" ${bgStyle}>
          <span class="tooltip shadow-lg z-50">
            ${tooltipText}
          </span>
        </div>
      `;
    }
    
    html += `
        </div>
      </div>
    `;
  }
  
  container.innerHTML = html;
}

/**
 * Populate filter dropdown selectors dynamically with active rooms & brands
 */
function populateFilterDropdowns() {
  const rooms = state.rooms || [];
  const brands = state.brands || [];
  
  const selectors = [
    { id: 'scheduler-filter-room', type: 'room', data: rooms, defaultText: 'ทุกห้องสตูดิโอ' },
    { id: 'scheduler-filter-brand', type: 'brand', data: brands, defaultText: 'ทุกแบรนด์' },
    { id: 'calendar-filter-room', type: 'room', data: rooms, defaultText: 'ทุกห้องสตูดิโอ' },
    { id: 'calendar-filter-brand', type: 'brand', data: brands, defaultText: 'ทุกแบรนด์' }
  ];
  
  selectors.forEach(sel => {
    const el = document.getElementById(sel.id);
    if (!el) return;
    
    // Remember current selection
    const currentVal = state.filters[sel.type] || "";
    
    el.innerHTML = `<option value="">${sel.defaultText}</option>`;
    sel.data.forEach(item => {
      el.innerHTML += `<option value="${item.name}">${item.name}</option>`;
    });
    
    // Restore selection
    el.value = currentVal;
  });

  // Also sync status dropdown values
  const schedulerStatus = document.getElementById('scheduler-filter-status');
  if (schedulerStatus) {
    schedulerStatus.value = state.filters.status || "";
  }
  const calendarStatus = document.getElementById('calendar-filter-status');
  if (calendarStatus) {
    calendarStatus.value = state.filters.status || "";
  }
}

function populateBookingFormBrands(targetValue) {
  const brandSelect = document.getElementById('booking-form-brand');
  if (brandSelect) {
    brandSelect.innerHTML = `<option value="">-- เลือกแบรนด์ --</option>`;
    const filteredBrands = (state.brands || []).filter(b => {
      if (!state.currentUser) return false;
      if (getUserRole() === 'master admin' || (state.currentUser.permissions && state.currentUser.permissions.isAdmin)) return true;
      return b.owner && b.owner.toLowerCase() === state.currentUser.email.toLowerCase();
    });
    filteredBrands.forEach(b => {
      brandSelect.innerHTML += `<option value="${b.name}">${b.name}</option>`;
    });
    
    // If a specific value is requested (edit mode), ensure it's always an option
    const valToSet = targetValue !== undefined ? targetValue : brandSelect.value;
    if (valToSet) {
      let found = false;
      for (let i = 0; i < brandSelect.options.length; i++) {
        if (brandSelect.options[i].value === valToSet) { found = true; break; }
      }
      if (!found && valToSet) {
        brandSelect.innerHTML += `<option value="${valToSet}">${valToSet}</option>`;
      }
      brandSelect.value = valToSet;
    }
  }
}

function populateCampaignSuggestions() {
  const datalist = document.getElementById('campaign-suggestions');
  if (!datalist) return;
  
  const campaigns = new Set();
  if (state.calendarBookings) {
    state.calendarBookings.forEach(b => {
      if (b.campaignName) campaigns.add(b.campaignName.trim());
    });
  }
  if (state.bookings) {
    state.bookings.forEach(b => {
      if (b.campaignName) campaigns.add(b.campaignName.trim());
    });
  }
  if (state.myBookings) {
    state.myBookings.forEach(b => {
      if (b.campaignName) campaigns.add(b.campaignName.trim());
    });
  }
  
  const sorted = Array.from(campaigns).sort();
  datalist.innerHTML = sorted.map(c => `<option value="${c}">`).join('');
}

/**
 * Handle filter dropdown changes and apply to views
 */
function handleFilterChange(type, value) {
  state.filters[type] = value;
  
  // Synchronize selector values across tabs
  const schedulerEl = document.getElementById(`scheduler-filter-${type}`);
  if (schedulerEl) schedulerEl.value = value;
  
  const calendarEl = document.getElementById(`calendar-filter-${type}`);
  if (calendarEl) calendarEl.value = value;
  
  // Check if any filter is active to show/hide "Clear Filters" button
  const hasActiveFilter = Object.keys(state.filters).some(key => {
    if (key === 'action') return state.filters[key] !== 'all';
    return state.filters[key] !== '';
  });
  
  const schedulerClearBtn = document.getElementById('scheduler-clear-filters-btn');
  if (schedulerClearBtn) {
    if (hasActiveFilter) schedulerClearBtn.classList.remove('hidden');
    else schedulerClearBtn.classList.add('hidden');
  }
  
  const calendarClearBtn = document.getElementById('calendar-clear-filters-btn');
  if (calendarClearBtn) {
    if (hasActiveFilter) calendarClearBtn.classList.remove('hidden');
    else calendarClearBtn.classList.add('hidden');
  }
  
  // Re-render active tab
  if (state.currentTab === 'scheduler') {
    renderTimelineScheduler();
  } else if (state.currentTab === 'calendar') {
    renderCalendarGrid();
  }
}

/**
 * Handle scheduler Action filter changes
 */
function handleFilterActionChange(value) {
  state.filters.action = value;
  
  // Check if any filter is active to show/hide "Clear Filters" button
  const hasActiveFilter = Object.keys(state.filters).some(key => {
    if (key === 'action') return state.filters[key] !== 'all';
    return state.filters[key] !== '';
  });
  
  const schedulerClearBtn = document.getElementById('scheduler-clear-filters-btn');
  if (schedulerClearBtn) {
    if (hasActiveFilter) schedulerClearBtn.classList.remove('hidden');
    else schedulerClearBtn.classList.add('hidden');
  }
  
  renderTimelineScheduler();
}

/**
 * Clear all search filters and reset dropdown selectors
 */
function clearAllFilters() {
  state.filters = { room: '', brand: '', status: '', action: 'all' };
  
  // Reset select elements
  const filterTypes = ['room', 'brand', 'status'];
  filterTypes.forEach(type => {
    const schedulerEl = document.getElementById(`scheduler-filter-${type}`);
    if (schedulerEl) schedulerEl.value = '';
    
    const calendarEl = document.getElementById(`calendar-filter-${type}`);
    if (calendarEl) calendarEl.value = '';
  });
  
  const actionEl = document.getElementById('scheduler-filter-action');
  if (actionEl) actionEl.value = 'all';
  
  // Hide clear buttons
  const schedulerClearBtn = document.getElementById('scheduler-clear-filters-btn');
  if (schedulerClearBtn) schedulerClearBtn.classList.add('hidden');
  
  const calendarClearBtn = document.getElementById('calendar-clear-filters-btn');
  if (calendarClearBtn) calendarClearBtn.classList.add('hidden');
  
  // Re-render active tab
  if (state.currentTab === 'scheduler') {
    renderTimelineScheduler();
  } else if (state.currentTab === 'calendar') {
    renderCalendarGrid();
  }
}

/**
 * LINE Notification Settings functions
 */
function loadSettingsTab(isSilent = false) {
  if (!hasTabPermission('settings')) {
    showToast("คุณไม่มีสิทธิ์เข้าถึงหน้านี้", "error");
    switchTab('scheduler');
    return;
  }
  
  if (!isSilent) {
    document.getElementById('settings-line-enabled').disabled = true;
    document.getElementById('settings-line-token').disabled = true;
    document.getElementById('settings-line-token').placeholder = "กำลังโหลดข้อมูล...";
    document.getElementById('settings-line-dest').disabled = true;
    document.getElementById('settings-line-dest').placeholder = "กำลังโหลดข้อมูล...";
    document.getElementById('settings-frontend-url').disabled = true;
    document.getElementById('settings-frontend-url').placeholder = "กำลังโหลดข้อมูล...";
  }
  
  apiCall('getSystemSettings', {}, (err, data) => {
    document.getElementById('settings-line-enabled').disabled = false;
    document.getElementById('settings-line-token').disabled = false;
    document.getElementById('settings-line-token').placeholder = "ใส่ LONG-LIVED LINE CHANNEL ACCESS TOKEN ที่นี่";
    document.getElementById('settings-line-dest').disabled = false;
    document.getElementById('settings-line-dest').placeholder = "เช่น U11b2d1a... หรือ Ca1a2b3c...";
    document.getElementById('settings-frontend-url').disabled = false;
    document.getElementById('settings-frontend-url').placeholder = "เช่น https://xxxx.netlify.app";

    if (err) {
      showToast("ไม่สามารถโหลดข้อมูลการตั้งค่า: " + err, "error");
      return;
    }
    
    document.getElementById('settings-line-enabled').checked = data.lineNotificationsEnabled;
    document.getElementById('settings-line-token').value = data.lineChannelAccessToken;
    document.getElementById('settings-line-dest').value = data.lineDestinationId;
    document.getElementById('settings-frontend-url').value = data.frontendUrl || "";
    
    document.getElementById('settings-line-token').type = "password";
    const eyeIcon = document.getElementById('eye-icon-settings-line-token');
    if (eyeIcon) eyeIcon.setAttribute("data-lucide", "eye");
    if (window.lucide) {
      lucide.createIcons();
    }
  });
}

function saveSettings() {
  const enabled = document.getElementById('settings-line-enabled').checked;
  const token = document.getElementById('settings-line-token').value.trim();
  const destId = document.getElementById('settings-line-dest').value.trim();
  const frontendUrl = document.getElementById('settings-frontend-url').value.trim();
  
  if (enabled && (!token || !destId)) {
    showToast("กรุณากรอกข้อมูล LINE Access Token และ Destination ID ให้ครบถ้วนเมื่อเปิดการแจ้งเตือน", "warning");
    return;
  }
  
  const saveBtn = document.querySelector('#settings-form button[type="submit"]');
  const origHtml = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></span> กำลังบันทึก...`;
  
  const settingsData = {
    lineNotificationsEnabled: enabled,
    lineChannelAccessToken: token,
    lineDestinationId: destId,
    frontendUrl: frontendUrl
  };
  
  apiCall('saveSystemSettings', { settings: settingsData }, (err, data) => {
    saveBtn.disabled = false;
    saveBtn.innerHTML = origHtml;
    
    if (err) {
      showToast("บันทึกการตั้งค่าล้มเหลว: " + err, "error");
      return;
    }
    
    showToast("บันทึกการตั้งค่าระบบเรียบร้อยแล้ว!", "success");
    state.tabLoaded['settings'] = true;
  });
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  const icon = document.getElementById(`eye-icon-${inputId}`);
  if (input.type === "password") {
    input.type = "text";
    if (icon) icon.setAttribute("data-lucide", "eye-off");
  } else {
    input.type = "password";
    if (icon) icon.setAttribute("data-lucide", "eye");
  }
  if (window.lucide) {
    lucide.createIcons();
  }
}

/**
 * Copy text to clipboard and display a toast notification
 */
function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast("คัดลอกลิงก์สำเร็จ!", "success");
  }).catch(err => {
    console.error("Failed to copy:", err);
    showToast("คัดลอกล้มเหลว", "error");
  });
}

/**
 * Toggle mobile sidebar menu visibility
 */
function toggleSidebar(open) {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar && backdrop) {
    if (open) {
      sidebar.classList.remove('-translate-x-full');
      sidebar.classList.add('translate-x-0');
      backdrop.classList.remove('hidden');
      document.body.style.overflow = 'hidden'; // Lock background scrolling on mobile
    } else {
      sidebar.classList.add('-translate-x-full');
      sidebar.classList.remove('translate-x-0');
      backdrop.classList.add('hidden');
      document.body.style.overflow = ''; // Unlock background scrolling
    }
  }
}

/**
 * Check for scheduling conflicts before saving
 */
function checkBookingConflict() {
  const room = document.getElementById('booking-form-room').value;
  const date = document.getElementById('booking-form-date').value;
  const startTime = document.getElementById('booking-form-start-time').value;
  const endTime = document.getElementById('booking-form-end-time').value;
  const bookingId = document.getElementById('booking-modal-id').value;
  
  const conflictAlert = document.getElementById('booking-conflict-alert');
  const conflictText = document.getElementById('booking-conflict-text');
  const saveBtn = document.getElementById('btn-save-booking');
  
  if (!room || !date || !startTime || !endTime) {
    if (conflictAlert) conflictAlert.classList.add('hidden');
    if (saveBtn) saveBtn.disabled = false;
    return;
  }
  
  const startMins = parseTimeToMinutes(startTime);
  const endMins = parseTimeToMinutes(endTime);
  
  if (endMins <= startMins) {
    if (conflictAlert) {
      conflictAlert.classList.remove('hidden');
      conflictText.innerText = "เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม";
      conflictAlert.classList.remove('animate-shake');
      void conflictAlert.offsetWidth;
      conflictAlert.classList.add('animate-shake');
    }
    if (saveBtn) saveBtn.disabled = true;
    return;
  }
  
  // Find duplicate bookings in state.calendarBookings, fall back to date-specific state.bookings on cold start
  const conflictPool = (state.calendarBookings && state.calendarBookings.length > 0)
    ? state.calendarBookings
    : (state.bookings || []);

  const conflict = conflictPool.find(b => {
    // Exclude cancelled bookings and the current booking if editing
    if (b.status === 'Cancelled' || b.id === bookingId) return false;
    if (b.roomName !== room || b.date !== date) return false;
    
    const bStart = parseTimeToMinutes(b.startTime);
    const bEnd = parseTimeToMinutes(b.endTime);
    
    // Check overlap
    return !(endMins <= bStart || startMins >= bEnd);
  });
    
    if (conflict) {
      if (conflictAlert) {
        conflictAlert.classList.remove('hidden');
        conflictText.innerText = `สตูดิโอนี้ถูกจองแล้วโดยแคมเปญ "${conflict.campaignName}" (${conflict.brandName}) ในช่วงเวลา ${conflict.startTime} - ${conflict.endTime} น.`;
        conflictAlert.classList.remove('animate-shake');
        void conflictAlert.offsetWidth;
        conflictAlert.classList.add('animate-shake');
      }
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
  
  if (conflictAlert) conflictAlert.classList.add('hidden');
  if (saveBtn) saveBtn.disabled = false;
}

// Global mouseup handler to finalize scheduler drag-to-select booking
window.addEventListener('mouseup', () => {
  if (state.isDragging && state.dragStartCell) {
    state.isDragging = false;
    
    // Find all highlighted cells in the Scheduler
    const highlighted = document.querySelectorAll('.timeline-grid-cell.bg-brand-100\\/50');
    if (highlighted.length > 0) {
      let minMins = Infinity;
      let maxMins = -Infinity;
      const roomName = state.dragStartCell.roomName;
      
      highlighted.forEach(el => {
        const m = parseInt(el.dataset.mins);
        if (m < minMins) minMins = m;
        if (m > maxMins) maxMins = m;
      });
      
      const startMins = minMins;
      const endMins = maxMins + CELL_DURATION_MINS;
      
      const sh = Math.floor(startMins / 60);
      const sm = startMins % 60;
      const eh = Math.floor(endMins / 60);
      const em = endMins % 60;
      
      const stStr = `${sh < 10 ? '0'+sh : sh}:${sm < 10 ? '0'+sm : sm}`;
      const etStr = `${eh < 10 ? '0'+eh : eh}:${em < 10 ? '0'+em : em}`;
      
      openBookingCreateFromGrid(roomName, stStr, etStr);
    }
    
    // Clean highlights
    document.querySelectorAll('.timeline-grid-cell').forEach(cell => {
      cell.classList.remove('bg-brand-100/50', 'dark:bg-brand-900/30', 'border-brand-500/30');
    });
    
    state.dragStartCell = null;
  }
});

// ==================== 8. CAMPAIGN LIVE SCHEDULE DASHBOARD ====================

function loadCampaignScheduleView(isSilent = false) {
  const startInput = document.getElementById('campaign-schedule-start-date');
  const endInput = document.getElementById('campaign-schedule-end-date');
  
  if (startInput && !startInput.value) {
    startInput.value = state.selectedDate;
  }
  if (endInput && !endInput.value) {
    endInput.value = state.selectedDate;
  }

  let hasCache = false;
  try {
    const cachedCalendarStr = localStorage.getItem('cached_calendar_bookings');
    if (cachedCalendarStr) {
      state.calendarBookings = JSON.parse(cachedCalendarStr);
      renderCampaignSchedule();
      hasCache = true;
    }
  } catch (e) {
    console.error("Error reading cache for campaign schedule:", e);
  }

  const silentMode = isSilent || hasCache;

  if (!silentMode) {
    const tbody = document.getElementById('campaign-schedule-table-body');
    if (tbody) {
      tbody.innerHTML = skTableRows(8, [
        { w: '15%' }, // วันที่ / เวลา
        { w: '12%' }, // ห้อง
        { w: '12%' }, // ชั่วโมงสะสมห้อง
        { w: '18%' }, // แบรนด์ / แคมเปญ
        { w: '20%' }, // รายละเอียด
        { w: '13%' }, // ผู้จอง
        { w: '10%' }, // สถานะรายการ
      ]);
    }
  }

  apiCall('getAllBookings', {}, (err, data) => {
    if (err) {
      showToast("ไม่สามารถดึงข้อมูลคิวจองได้: " + err, "error");
      return;
    }
    
    detectAndNotifyNewBookings(state.calendarBookings, data.bookings);
    state.calendarBookings = mergeServerBookings(state.calendarBookings, data.bookings);
    
    try {
      localStorage.setItem('cached_calendar_bookings', JSON.stringify(state.calendarBookings));
    } catch (e) {
      console.error("Error writing cache in campaign schedule:", e);
    }
    
    renderCampaignSchedule();
  });
}

function toggleCampaignScheduleAllDates() {
  const allDatesChecked = document.getElementById('campaign-schedule-all-dates').checked;
  const startInput = document.getElementById('campaign-schedule-start-date');
  const endInput = document.getElementById('campaign-schedule-end-date');
  
  if (allDatesChecked) {
    startInput.disabled = true;
    endInput.disabled = true;
    startInput.classList.add('opacity-50', 'cursor-not-allowed');
    endInput.classList.add('opacity-50', 'cursor-not-allowed');
  } else {
    startInput.disabled = false;
    endInput.disabled = false;
    startInput.classList.remove('opacity-50', 'cursor-not-allowed');
    endInput.classList.remove('opacity-50', 'cursor-not-allowed');
  }
  
  filterCampaignSchedule();
}

function filterCampaignSchedule() {
  state.campaignSchedulePage = 1; // Reset to page 1 on filter changes
  renderCampaignSchedule();
}

function renderCampaignSchedule() {
  const startInput = document.getElementById('campaign-schedule-start-date');
  const endInput = document.getElementById('campaign-schedule-end-date');
  const allDatesCheckbox = document.getElementById('campaign-schedule-all-dates');
  
  if (!startInput || !endInput || !allDatesCheckbox) return;

  const startDate = startInput.value;
  const endDate = endInput.value;
  const allDates = allDatesCheckbox.checked;

  const bookings = state.calendarBookings || [];

  // 1. Filter by Date range (exclude Cancelled bookings from active hours, brand lists, owner lists)
  const bookingsInDateRange = bookings.filter(b => {
    if (b.status === 'Cancelled') return false;
    if (allDates) return true;
    if (!startDate || !endDate) return true; // fallback if empty
    return b.date >= startDate && b.date <= endDate;
  });

  // 2. Populate dynamic dropdowns (Active Rooms, Active Brands & Active Owners in this date range)
  const roomDropdown = document.getElementById('campaign-schedule-filter-room');
  const brandDropdown = document.getElementById('campaign-schedule-filter-brand');
  const ownerDropdown = document.getElementById('campaign-schedule-filter-owner');
  
  if (roomDropdown) {
    const prevSelectedRoom = roomDropdown.value || 'All';
    const roomList = state.rooms && state.rooms.length > 0
      ? state.rooms.map(r => r.name)
      : [...new Set(bookingsInDateRange.map(b => b.roomName))].sort();
      
    const roomListKey = roomList.join('|');
    if (state.lastCampaignRoomsKey !== roomListKey) {
      state.lastCampaignRoomsKey = roomListKey;
      let roomHtml = '<option value="All">ทุกห้อง (All Rooms)</option>';
      roomList.forEach(r => {
        roomHtml += `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`;
      });
      roomDropdown.innerHTML = roomHtml;
      
      if (roomList.includes(prevSelectedRoom)) {
        roomDropdown.value = prevSelectedRoom;
      } else {
        roomDropdown.value = 'All';
      }
    }
  }

  if (brandDropdown && ownerDropdown) {
    const prevSelectedBrand = brandDropdown.value || 'All';
    const prevSelectedOwner = ownerDropdown.value || 'All';

    const activeBrands = [...new Set(bookingsInDateRange.map(b => b.brandName))].sort();
    const activeOwners = [...new Set(bookingsInDateRange.map(b => b.ownerName))].sort();

    const activeBrandsKey = activeBrands.join('|');
    const activeOwnersKey = activeOwners.join('|');

    if (state.lastCampaignBrandsKey !== activeBrandsKey) {
      state.lastCampaignBrandsKey = activeBrandsKey;
      let brandHtml = '<option value="All">ทุกแบรนด์ (All)</option>';
      activeBrands.forEach(b => {
        brandHtml += `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`;
      });
      brandDropdown.innerHTML = brandHtml;
      
      if (activeBrands.includes(prevSelectedBrand)) {
        brandDropdown.value = prevSelectedBrand;
      } else {
        brandDropdown.value = 'All';
      }
    }

    if (state.lastCampaignOwnersKey !== activeOwnersKey) {
      state.lastCampaignOwnersKey = activeOwnersKey;
      let ownerHtml = '<option value="All">ผู้จองทั้งหมด (All)</option>';
      activeOwners.forEach(o => {
        ownerHtml += `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`;
      });
      ownerDropdown.innerHTML = ownerHtml;

      if (activeOwners.includes(prevSelectedOwner)) {
        ownerDropdown.value = prevSelectedOwner;
      } else {
        ownerDropdown.value = 'All';
      }
    }
  }

  const selectedRoom = roomDropdown ? roomDropdown.value : 'All';
  const selectedBrand = brandDropdown ? brandDropdown.value : 'All';
  const selectedOwner = ownerDropdown ? ownerDropdown.value : 'All';
  const selectedStatus = document.getElementById('campaign-schedule-filter-status').value;
  const sortVal = document.getElementById('campaign-schedule-sort').value;

  // 3. Compute Room live hours based on bookings in the selected date range
  const roomHours = {};
  const roomBookingCounts = {};
  bookingsInDateRange.forEach(b => {
    const startMins = parseTimeToMinutes(b.startTime);
    const endMins = parseTimeToMinutes(b.endTime);
    if (endMins > startMins) {
      const durHours = (endMins - startMins) / 60;
      roomHours[b.roomName] = (roomHours[b.roomName] || 0) + durHours;
      roomBookingCounts[b.roomName] = (roomBookingCounts[b.roomName] || 0) + 1;
    }
  });

  // Render cumulative room stats cards
  const allRoomsList = state.rooms && state.rooms.length > 0
    ? state.rooms.map(r => r.name)
    : [...new Set(bookings.map(b => b.roomName))].sort();

  let summaryHtml = '';
  if (allRoomsList.length === 0) {
    summaryHtml = `<div class="col-span-full text-center text-slate-400 py-4 text-xs italic">ไม่มีข้อมูลห้องในระบบ</div>`;
  } else {
    allRoomsList.forEach(roomName => {
      const hours = roomHours[roomName] || 0;
      const count = roomBookingCounts[roomName] || 0;
      summaryHtml += `
        <div class="bg-slate-50 dark:bg-slate-800/40 p-3 rounded-lg border border-slate-100 dark:border-slate-800 flex flex-col justify-between shadow-sm">
          <span class="text-xs text-slate-500 dark:text-slate-400 font-semibold truncate">${escapeHtml(roomName)}</span>
          <span class="text-lg font-extrabold text-brand-600 dark:text-brand-400 mt-1">${hours.toFixed(1)} ชม.</span>
          <span class="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">${count} รายการจอง</span>
        </div>
      `;
    });
  }
  const summaryContainer = document.getElementById('campaign-schedule-room-summary');
  if (summaryContainer) {
    summaryContainer.innerHTML = summaryHtml;
  }

  // 4. Apply filters to compute the list of bookings to display (matches summary card date filter logic)
  let finalBookings = [...bookingsInDateRange];

  if (selectedRoom && selectedRoom !== 'All') {
    finalBookings = finalBookings.filter(b => b.roomName === selectedRoom);
  }

  if (selectedBrand && selectedBrand !== 'All') {
    finalBookings = finalBookings.filter(b => b.brandName === selectedBrand);
  }
  if (selectedOwner && selectedOwner !== 'All') {
    finalBookings = finalBookings.filter(b => b.ownerName === selectedOwner);
  }

  // Filter by Campaign Status Category
  if (selectedStatus && selectedStatus !== 'All') {
    const todayObj = new Date();
    const todayDateStr = todayObj.getFullYear() + '-' + String(todayObj.getMonth() + 1).padStart(2, '0') + '-' + String(todayObj.getDate()).padStart(2, '0');
    const currentMins = todayObj.getHours() * 60 + todayObj.getMinutes();

    if (selectedStatus === 'ActiveNow') {
      finalBookings = finalBookings.filter(b => {
        const isToday = b.date === todayDateStr;
        const startMins = parseTimeToMinutes(b.startTime);
        const endMins = parseTimeToMinutes(b.endTime);
        return isToday && (currentMins >= startMins && currentMins <= endMins) && b.status === 'Confirmed';
      });
    } else if (selectedStatus === 'BookingToday') {
      finalBookings = finalBookings.filter(b => b.date === todayDateStr);
    } else if (selectedStatus === 'Upcoming') {
      finalBookings = finalBookings.filter(b => {
        const isFutureDate = b.date > todayDateStr;
        const isToday = b.date === todayDateStr;
        const startMins = parseTimeToMinutes(b.startTime);
        const isUpcomingToday = isToday && (startMins > currentMins);
        return (isFutureDate || isUpcomingToday) && b.status === 'Confirmed';
      });
    } else if (selectedStatus === 'Upcoming1Hour') {
      finalBookings = finalBookings.filter(b => {
        const isToday = b.date === todayDateStr;
        const startMins = parseTimeToMinutes(b.startTime);
        const diffMins = startMins - currentMins;
        return isToday && (diffMins > 0 && diffMins <= 60) && b.status === 'Confirmed';
      });
    }
  }

  // 5. Apply Sorting
  if (sortVal === 'created_asc') {
    const orderMap = new Map();
    bookings.forEach((b, idx) => {
      orderMap.set(b.id, idx);
    });
    finalBookings.sort((a, b) => orderMap.get(a.id) - orderMap.get(b.id));
  } else if (sortVal === 'created_desc') {
    const orderMap = new Map();
    bookings.forEach((b, idx) => {
      orderMap.set(b.id, idx);
    });
    finalBookings.sort((a, b) => orderMap.get(b.id) - orderMap.get(a.id));
  } else if (sortVal === 'room_hours_desc') {
    finalBookings.sort((a, b) => {
      const hoursA = roomHours[a.roomName] || 0;
      const hoursB = roomHours[b.roomName] || 0;
      if (hoursB !== hoursA) {
        return hoursB - hoursA;
      }
      return a.roomName.localeCompare(b.roomName);
    });
  } else if (sortVal === 'room_hours_asc') {
    finalBookings.sort((a, b) => {
      const hoursA = roomHours[a.roomName] || 0;
      const hoursB = roomHours[b.roomName] || 0;
      if (hoursA !== hoursB) {
        return hoursA - hoursB;
      }
      return a.roomName.localeCompare(b.roomName);
    });
  }
  // Store filtered list for exporting
  state.lastCampaignBookings = finalBookings;

  // 6. Pagination Slicing
  const totalItems = finalBookings.length;
  const totalPages = Math.ceil(totalItems / state.campaignSchedulePageSize) || 1;
  
  if (state.campaignSchedulePage > totalPages) {
    state.campaignSchedulePage = totalPages;
  }
  if (state.campaignSchedulePage < 1) {
    state.campaignSchedulePage = 1;
  }
  
  const startIdx = (state.campaignSchedulePage - 1) * state.campaignSchedulePageSize;
  const endIdx = startIdx + state.campaignSchedulePageSize;
  const pageBookings = finalBookings.slice(startIdx, endIdx);

  // 7. Render table rows
  const tbody = document.getElementById('campaign-schedule-table-body');
  if (!tbody) return;

  if (finalBookings.length === 0) {
    const pagContainer = document.getElementById('campaign-schedule-pagination-container');
    if (pagContainer) pagContainer.innerHTML = '';
    const canCreate = state.currentUser && state.currentUser.permissions && state.currentUser.permissions.canCreateBooking;
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="p-8 text-center text-slate-400">
          <div class="flex flex-col items-center gap-3 py-6">
            <div class="p-4 bg-slate-50 dark:bg-slate-900/50 text-slate-400 rounded-full border border-slate-100 dark:border-slate-800 shadow-inner">
              <i data-lucide="calendar-days" class="w-8 h-8"></i>
            </div>
            <div class="text-sm font-semibold text-slate-600 dark:text-slate-400">ไม่พบตารางงานไลฟ์ที่สอดคล้องกับตัวกรอง</div>
            <p class="text-xs text-slate-400 max-w-[280px]">ไม่มีรายการจองคิวในสตูดิโอช่วงเวลาและตัวกรองที่กำหนด</p>
            ${canCreate ? `
              <button onclick="openBookingModal()" class="mt-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs font-semibold shadow-md shadow-brand-500/20 flex items-center gap-1.5 transition-all hover:scale-105 active:scale-95">
                <i data-lucide="plus" class="w-3.5 h-3.5"></i> จองห้องไลฟ์สดใหม่
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  tbody.innerHTML = "";
  
  const todayObj = new Date();
  const todayDateStr = todayObj.getFullYear() + '-' + String(todayObj.getMonth() + 1).padStart(2, '0') + '-' + String(todayObj.getDate()).padStart(2, '0');
  const currentMins = todayObj.getHours() * 60 + todayObj.getMinutes();

  pageBookings.forEach(b => {
    // Booking duration hours
    let durationHours = 0;
    if (b.startTime && b.endTime) {
      const startMins = parseTimeToMinutes(b.startTime);
      const endMins = parseTimeToMinutes(b.endTime);
      let diff = endMins - startMins;
      if (diff < 0) {
        diff += 24 * 60; // handle midnight crossing
      }
      durationHours = diff / 60;
    }

    // Status Badge
    let statusClass = "bg-blue-50 text-blue-700 border-blue-200";
    let statusThText = "Confirmed";
    if (b.status === "Completed") {
      statusClass = "bg-emerald-50 text-emerald-700 border-emerald-200";
      statusThText = "Completed";
    }
    const statusCellHtml = `<span class="px-2.5 py-1 text-xs font-bold rounded-full border ${statusClass}">${statusThText}</span>`;

    // Live Pill
    const startMins = parseTimeToMinutes(b.startTime);
    const endMins = parseTimeToMinutes(b.endTime);
    let livePill = '';
    if (b.date === todayDateStr && currentMins >= startMins && currentMins <= endMins && b.status === 'Confirmed') {
      livePill = `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-100 text-rose-800 animate-pulse ml-2">
                    <span class="w-1.5 h-1.5 rounded-full bg-rose-600"></span>LIVE NOW
                  </span>`;
    }

    // Build links (brief + artwork)
    let linksHtml = "";
    const allLinks = [];
    if (b.briefLink) {
      allLinks.push({ type: "Brief", url: b.briefLink });
    }
    if (b.lsArtworkLayout) {
      try {
        const list = JSON.parse(b.lsArtworkLayout);
        if (Array.isArray(list)) {
          list.forEach(item => {
            if (item.url) {
              allLinks.push({ type: item.type || "Link", url: item.url });
            }
          });
        }
      } catch (e) {
        const url = b.lsArtworkLayout.trim();
        if (url.startsWith("http")) {
          allLinks.push({ type: "Artwork", url: url });
        }
      }
    }
    
    if (allLinks.length > 0) {
      const linksList = allLinks.map(item => {
        return `
          <div class="inline-flex items-center gap-1 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 text-[10px] w-fit">
            <a href="${item.url}" target="_blank" class="hover:underline truncate max-w-[80px]" title="${item.url}">${item.type}</a>
            <button onclick="copyToClipboard('${item.url}')" class="text-slate-400 hover:text-brand-600 p-0.5 focus:outline-none" title="คัดลอกลิงก์">
              <i data-lucide="copy" class="w-2.5 h-2.5"></i>
            </button>
          </div>
        `;
      });
      linksHtml = `<div class="flex flex-wrap gap-1 mt-1.5">${linksList.join('')}</div>`;
    } else {
      linksHtml = `<span class="text-slate-400 text-xs italic">ไม่มีลิงก์</span>`;
    }

    tbody.innerHTML += `
      <tr class="hover:bg-slate-50/50 dark:hover:bg-slate-800/20">
        <td class="p-4">
          <div class="font-bold text-slate-900 dark:text-slate-100">${formatThaiDate(b.date)}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 font-medium mt-0.5">${b.startTime} - ${b.endTime} น.</div>
        </td>
        <td class="p-4 font-semibold text-slate-700 dark:text-slate-300">
          ${escapeHtml(b.roomName)}
        </td>
        <td class="p-4 font-bold text-slate-900 dark:text-slate-100">
          ${durationHours.toFixed(1)} ชม.
        </td>
        <td class="p-4">
          <div class="font-bold text-brand-700 dark:text-brand-400 flex items-center">${escapeHtml(b.brandName)}${livePill}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(b.campaignName)}</div>
        </td>
        <td class="p-4">
          <div class="text-xs text-slate-600 dark:text-slate-300 max-w-[280px] break-words whitespace-pre-line">${b.briefText || '-'}</div>
          ${linksHtml}
        </td>
        <td class="p-4 text-xs">
          <div class="font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(b.ownerName || '-')}</div>
          <div class="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">${escapeHtml(b.ownerEmail || '')}</div>
        </td>
        <td class="p-4">
          ${statusCellHtml}
        </td>
      </tr>
    `;
  });

  lucide.createIcons();
  renderCampaignSchedulePagination(totalItems, totalPages);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Export campaign schedule data matching the requested Excel columns:
 * ล (Date) | day (Day of Week) | start (Start Time) | end (End Time) | hrs (Duration) | brand (Brand)
 */
function exportCampaignScheduleToExcel() {
  const list = state.lastCampaignBookings;
  if (!list || list.length === 0) {
    showToast("ไม่มีข้อมูลในตารางสำหรับส่งออก Excel", "warning");
    return;
  }
  
  const headers = ['ล', 'day', 'start', 'end', 'hrs', 'brand'];
  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  const csvRows = [headers.join(',')];
  
  list.forEach(b => {
    // 1. Format date (ล) e.g., 4-Jul-2026
    let formattedDate = b.date || "";
    let dayAbbrev = "";
    if (b.date) {
      const parts = b.date.split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const monthIdx = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        
        formattedDate = `${day}-${monthsShort[monthIdx]}-${year}`;
        
        // Use UTC date to bypass local timezone offsets
        const dObj = new Date(Date.UTC(year, monthIdx, day));
        dayAbbrev = daysShort[dObj.getUTCDay()];
      }
    }
    
    // 2. Start & End times
    const start = b.startTime || "";
    const end = b.endTime || "";
    
    // 3. Format hrs e.g. 14:00
    let hrsText = "";
    if (start && end) {
      const startMins = parseTimeToMinutes(start);
      const endMins = parseTimeToMinutes(end);
      let diff = endMins - startMins;
      if (diff < 0) {
        diff += 24 * 60; // handle midnight crossing
      }
      const hours = Math.floor(diff / 60);
      const minutes = diff % 60;
      hrsText = `${hours}:${minutes < 10 ? '0' + minutes : minutes}`;
    }
    
    // 4. Format brand (quote escape for CSV safety)
    const brand = `"${(b.brandName || "").replace(/"/g, '""')}"`;
    
    const row = [formattedDate, dayAbbrev, start, end, hrsText, brand];
    csvRows.push(row.join(','));
  });
  
  // Combine rows with UTF-8 BOM to prevent Thai encoding issues in Excel/Google Sheets
  const csvContent = "\uFEFF" + csvRows.join("\n");
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  
  const todayStr = getFormattedDate(new Date());
  link.setAttribute("download", `campaign_schedule_${todayStr}.csv`);
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showToast("ดาวน์โหลดไฟล์ตารางงานแคมเปญสำเร็จ (CSV)", "success");
}

function renderCampaignSchedulePagination(totalItems, totalPages) {
  const container = document.getElementById('campaign-schedule-pagination-container');
  if (!container) return;
  
  if (totalItems === 0) {
    container.innerHTML = '';
    return;
  }
  
  let pageButtonsHtml = '';
  // Prev Button
  const isFirstPage = state.campaignSchedulePage === 1;
  pageButtonsHtml += `
    <button onclick="changeCampaignSchedulePage(${state.campaignSchedulePage - 1})" ${isFirstPage ? 'disabled' : ''} class="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-semibold ${isFirstPage ? 'text-slate-300 dark:text-slate-700 cursor-not-allowed' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'} transition-all flex items-center gap-1">
      <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i> ก่อนหน้า
    </button>
  `;
  
  // Page Numbers
  for (let p = 1; p <= totalPages; p++) {
    const isCurrent = p === state.campaignSchedulePage;
    pageButtonsHtml += `
      <button onclick="changeCampaignSchedulePage(${p})" class="w-8 h-8 rounded-lg text-xs font-bold transition-all ${isCurrent ? 'bg-brand-600 text-white shadow-md shadow-brand-600/20 border border-brand-600' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 border border-transparent hover:border-slate-200 dark:hover:border-slate-800'}">${p}</button>
    `;
  }
  
  // Next Button
  const isLastPage = state.campaignSchedulePage === totalPages;
  pageButtonsHtml += `
    <button onclick="changeCampaignSchedulePage(${state.campaignSchedulePage + 1})" ${isLastPage ? 'disabled' : ''} class="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-semibold ${isLastPage ? 'text-slate-300 dark:text-slate-700 cursor-not-allowed' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'} transition-all flex items-center gap-1">
      ถัดไป <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
    </button>
  `;
  
  const startRange = Math.min((state.campaignSchedulePage - 1) * state.campaignSchedulePageSize + 1, totalItems);
  const endRange = Math.min(state.campaignSchedulePage * state.campaignSchedulePageSize, totalItems);
  
  container.innerHTML = `
    <div class="flex flex-col sm:flex-row items-center justify-between gap-4 w-full">
      <!-- Left: Show entries count and selector -->
      <div class="flex items-center gap-2.5 text-xs text-slate-500 dark:text-slate-400">
        <span>แสดง</span>
        <select onchange="changeCampaignSchedulePageSize(this.value)" class="text-xs border border-slate-200 dark:border-slate-800 rounded px-2 py-1 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-brand-500">
          <option value="10" ${state.campaignSchedulePageSize === 10 ? 'selected' : ''}>10</option>
          <option value="20" ${state.campaignSchedulePageSize === 20 ? 'selected' : ''}>20</option>
          <option value="30" ${state.campaignSchedulePageSize === 30 ? 'selected' : ''}>30</option>
          <option value="50" ${state.campaignSchedulePageSize === 50 ? 'selected' : ''}>50</option>
        </select>
        <span>รายการ จากทั้งหมด <strong class="text-slate-700 dark:text-slate-300">${totalItems}</strong> รายการ (กำลังแสดง ${startRange}-${endRange})</span>
      </div>
      
      <!-- Right: Navigation buttons -->
      <div class="flex items-center gap-1.5">
        ${pageButtonsHtml}
      </div>
    </div>
  `;
  
  lucide.createIcons({
    attrs: {
      class: ["lucide-icon"]
    },
    nameAttr: "data-lucide"
  });
}

function changeCampaignSchedulePage(page) {
  state.campaignSchedulePage = page;
  renderCampaignSchedule();
}

function changeCampaignSchedulePageSize(size) {
  const sizeInt = parseInt(size, 10);
  state.campaignSchedulePageSize = sizeInt;
  localStorage.setItem('campaign_schedule_page_size', sizeInt);
  state.campaignSchedulePage = 1; // Reset to page 1
  renderCampaignSchedule();
}
