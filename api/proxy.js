const https = require('https');
const crypto = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// SECURE SALT FOR SESSION TOKENS
const TOKEN_SALT = "secure_salt_1234_TH_Booking";

// ── HELPERS FOR SUPABASE REST API ────────────────────────────────────────────
function requestSupabase(method, path, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    if (!supabaseUrl || !supabaseKey) {
      return reject(new Error("Missing SUPABASE_URL or SUPABASE_KEY in Vercel environment variables."));
    }

    const url = new URL(`${supabaseUrl}/rest/v1/${path}`);
    const payload = data ? JSON.stringify(data) : '';
    
    const reqHeaders = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      ...headers
    };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    
    const options = {
      method: method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: reqHeaders
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch(e) {
            resolve(body);
          }
        } else {
          reject(new Error(`Supabase error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── DATA MAPPING HELPERS ─────────────────────────────────────────────────────
function mapBookingToFrontend(b) {
  if (!b) return null;
  return {
    id: b.id,
    roomName: b.room_name,
    date: b.date,
    startTime: b.start_time,
    endTime: b.end_time,
    brandName: b.brand_name,
    campaignName: b.campaign_name,
    briefText: b.brief_text,
    briefLink: b.brief_link,
    lsArtworkLayout: b.ls_artwork_layout,
    ownerEmail: b.owner_email,
    ownerName: b.owner_name,
    status: b.status,
    remark: b.remark,
    createdAt: b.created_at
  };
}

function mapBookingToDb(b) {
  if (!b) return null;
  return {
    room_name: b.roomName,
    date: b.date,
    start_time: b.startTime,
    end_time: b.endTime,
    brand_name: b.brandName,
    campaign_name: b.campaignName || '',
    brief_text: b.briefText || '',
    brief_link: b.briefLink || '',
    ls_artwork_layout: b.lsArtworkLayout || '',
    owner_email: b.ownerEmail,
    owner_name: b.ownerName,
    status: b.status || 'Confirmed',
    remark: b.remark || ''
  };
}

// ── SECURITY & SESSION HELPERS ───────────────────────────────────────────────
function generateToken(email) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase() + TOKEN_SALT).digest('hex');
  return Buffer.from(email.toLowerCase() + ":" + hash).toString('base64');
}

async function verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    const hash = parts[parts.length - 1];
    const email = parts.slice(0, parts.length - 1).join(":");
    
    const expectedHash = crypto.createHash('sha256').update(email + TOKEN_SALT).digest('hex');
    if (hash !== expectedHash) return null;

    // Fetch user details + role permissions from Supabase
    const users = await requestSupabase('GET', `users?email=eq.${encodeURIComponent(email)}&select=*,roles(*)`);
    if (users && users.length > 0 && users[0].status === 'Active') {
      return users[0];
    }
  } catch (e) {
    console.error("Token verification failed:", e);
  }
  return null;
}

async function logActivity(user, action, target, details, ip = "-", device = "-") {
  try {
    await requestSupabase('POST', 'audit_logs', {
      user_email: user ? user.email : "system",
      user_name: user ? user.name : "System",
      action: action,
      target: target,
      details: details,
      ip: ip,
      device: device
    });
  } catch (err) {
    console.error("Failed to write audit log:", err);
  }
}

// ── VERCEL API HANDLER ────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  let params = {};
  if (typeof req.body === 'string') {
    try { params = JSON.parse(req.body); } catch(e) { params = {}; }
  } else if (req.body && typeof req.body === 'object') {
    params = req.body;
  }

  const action = params.action;
  if (!action) {
    return res.status(400).json({ success: false, message: 'Action parameter is required' });
  }

  try {
    // 1. Handle Anonymous Actions
    if (action === 'login') {
      const email = String(params.email || '').trim().toLowerCase();
      const password = String(params.password || '').trim();
      
      const users = await requestSupabase('GET', `users?email=eq.${encodeURIComponent(email)}&select=*,roles(*)`);
      if (!users || users.length === 0) {
        return res.status(200).json({ success: false, message: 'ไม่พบผู้ใช้งานในระบบ' });
      }
      const user = users[0];
      if (user.status !== 'Active') {
        return res.status(200).json({ success: false, message: 'บัญชีผู้ใช้งานนี้ถูกระงับการใช้งานชั่วคราว' });
      }
      if (user.password !== password) {
        return res.status(200).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
      }

      const token = generateToken(user.email);
      await logActivity(user, "LOGIN", user.email, "User logged in successfully");

      const rolePerms = user.roles || {
        allowed_tabs: 'my-bookings,calendar,scheduler,campaign-schedule,analytics',
        can_create_booking: false,
        can_edit_booking: false,
        can_cancel_booking: false,
        is_admin: false
      };

      return res.status(200).json({
        success: true,
        token: token,
        user: {
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          permissions: {
            roleName: user.role,
            allowedTabs: rolePerms.allowed_tabs,
            canCreateBooking: rolePerms.can_create_booking,
            canEditBooking: rolePerms.can_edit_booking,
            canCancelBooking: rolePerms.can_cancel_booking,
            isAdmin: rolePerms.is_admin
          }
        }
      });
    }

    // 2. Authenticate all other actions
    const user = await verifyToken(params.token);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid authentication token or session expired.' });
    }

    const isAdmin = user.roles && user.roles.is_admin;

    // 3. Routing Actions
    switch (action) {
      case 'getInitData': {
        const rooms = await requestSupabase('GET', 'rooms?order=name.asc');
        const brands = await requestSupabase('GET', 'brands?status=eq.Active&order=name.asc');
        const dbBookings = await requestSupabase('GET', 'bookings?order=date.asc,start_time.asc');
        
        const mappedBookings = dbBookings.map(mapBookingToFrontend);

        let allRoomsAdmin = [];
        let allBrandsAdmin = [];
        let allUsersAdmin = [];
        let roles = [];

        if (isAdmin) {
          allRoomsAdmin = await requestSupabase('GET', 'rooms?order=name.asc');
          allBrandsAdmin = await requestSupabase('GET', 'brands?order=name.asc');
          allUsersAdmin = await requestSupabase('GET', 'users?select=*,roles(*)&order=email.asc');
          roles = await requestSupabase('GET', 'roles?order=role_name.asc');
        }

        const rolePerms = user.roles;
        const mappedUser = {
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          permissions: {
            roleName: user.role,
            allowedTabs: rolePerms.allowed_tabs,
            canCreateBooking: rolePerms.can_create_booking,
            canEditBooking: rolePerms.can_edit_booking,
            canCancelBooking: rolePerms.can_cancel_booking,
            isAdmin: rolePerms.is_admin
          }
        };

        const mappedUsersAdmin = allUsersAdmin.map(u => ({
          email: u.email,
          name: u.name,
          role: u.role,
          status: u.status,
          password: u.password // plain text password as matches user mgmt
        }));

        const mappedRolesAdmin = roles.map(r => ({
          roleName: r.role_name,
          description: r.description,
          allowedTabs: r.allowed_tabs,
          canCreateBooking: r.can_create_booking,
          canEditBooking: r.can_edit_booking,
          canCancelBooking: r.can_cancel_booking,
          isAdmin: r.is_admin
        }));

        return res.status(200).json({
          user: mappedUser,
          rooms,
          brands,
          allBookings: mappedBookings,
          allRoomsAdmin,
          allBrandsAdmin,
          allUsersAdmin: mappedUsersAdmin,
          roles: mappedRolesAdmin
        });
      }

      case 'getBookings': {
        const date = params.date;
        const dbBookings = await requestSupabase('GET', `bookings?date=eq.${date}&order=start_time.asc`);
        return res.status(200).json({ bookings: dbBookings.map(mapBookingToFrontend) });
      }

      case 'getMyBookings': {
        const dbBookings = await requestSupabase('GET', `bookings?owner_email=eq.${encodeURIComponent(user.email)}&order=date.asc,start_time.asc`);
        return res.status(200).json({ bookings: dbBookings.map(mapBookingToFrontend) });
      }

      case 'getAllBookings': {
        const dbBookings = await requestSupabase('GET', `bookings?order=date.asc,start_time.asc`);
        return res.status(200).json({ bookings: dbBookings.map(mapBookingToFrontend) });
      }

      case 'createBooking': {
        const bData = params.bookingData;
        const dbPayload = mapBookingToDb(bData);
        dbPayload.owner_email = user.email;
        dbPayload.owner_name = user.name;

        // Perform bulk/single insert
        const newBookings = await requestSupabase('POST', 'bookings', dbPayload, { 'Prefer': 'return=representation' });
        const inserted = Array.isArray(newBookings) ? newBookings[0] : newBookings;
        const bookingId = inserted ? inserted.id : null;

        await logActivity(user, "CREATE_BOOKING", dbPayload.room_name, `Room ${dbPayload.room_name}, Date ${dbPayload.date}, ${dbPayload.start_time}-${dbPayload.end_time}`);
        
        return res.status(200).json({ success: true, bookingId: bookingId });
      }

      case 'createBookingsBulk': {
        const list = params.bookingsList; // List of booking objects
        const dbPayloads = list.map(b => {
          const dbObj = mapBookingToDb(b);
          dbObj.owner_email = user.email;
          dbObj.owner_name = user.name;
          return dbObj;
        });

        await requestSupabase('POST', 'bookings', dbPayloads, { 'Prefer': 'return=representation' });
        await logActivity(user, "CREATE_BOOKINGS_BULK", `${list.length} slots`, `Bulk booking of ${list.length} slots started on ${list[0]?.date}`);

        return res.status(200).json({ success: true });
      }

      case 'updateBooking': {
        const id = params.bookingId;
        const bData = params.bookingData;
        const dbPayload = mapBookingToDb(bData);
        
        // Exclude updating owner if requested
        await requestSupabase('PATCH', `bookings?id=eq.${id}`, dbPayload);
        await logActivity(user, "UPDATE_BOOKING", id, `Updated Room ${dbPayload.room_name}, Date ${dbPayload.date}, ${dbPayload.start_time}-${dbPayload.end_time}`);
        
        return res.status(200).json({ success: true });
      }

      case 'cancelBooking': {
        const id = params.bookingId;
        await requestSupabase('PATCH', `bookings?id=eq.${id}`, { status: 'Cancelled' });
        await logActivity(user, "CANCEL_BOOKING", id, `Cancelled booking ID: ${id}`);
        
        return res.status(200).json({ success: true });
      }

      case 'updateArtworkLinks': {
        const id = params.bookingId;
        const links = params.artworkLinks;
        
        await requestSupabase('PATCH', `bookings?id=eq.${id}`, { ls_artwork_layout: links });
        await logActivity(user, "UPDATE_ARTWORK_LINKS", id, `Updated artwork links for booking ID: ${id}`);
        
        return res.status(200).json({ success: true });
      }

      case 'verifyMasterPassword': {
        const settingsList = await requestSupabase('GET', 'settings?key=eq.master_password');
        const storedPwd = settingsList && settingsList.length > 0 ? settingsList[0].value : 'Admin@1234';
        const success = (params.password === storedPwd);
        return res.status(200).json({ success });
      }

      case 'getActivityLogs': {
        if (!isAdmin) {
          return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const dbLogs = await requestSupabase('GET', 'audit_logs?order=created_at.desc&limit=500');
        const mappedLogs = dbLogs.map(l => ({
          timestamp: l.created_at,
          userEmail: l.user_email,
          userName: l.user_name,
          action: l.action,
          target: l.target,
          details: l.details,
          ip: l.ip,
          device: l.device
        }));
        return res.status(200).json({ logs: mappedLogs });
      }

      // --- ADMIN API ENDPOINTS ---
      case 'manageRooms': {
        if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden' });
        const subAction = params.subAction;
        const p = params.payload;

        if (subAction === 'CREATE') {
          await requestSupabase('POST', 'rooms', { name: p.name, description: p.description, status: p.status });
          await logActivity(user, "CREATE_ROOM", p.name, `Created room: ${p.name}`);
        } else if (subAction === 'UPDATE') {
          await requestSupabase('PATCH', `rooms?name=eq.${encodeURIComponent(p.oldName)}`, { name: p.name, description: p.description, status: p.status });
          await logActivity(user, "UPDATE_ROOM", p.name, `Updated room from ${p.oldName} to ${p.name}`);
        } else if (subAction === 'DELETE') {
          await requestSupabase('DELETE', `rooms?name=eq.${encodeURIComponent(p.name)}`);
          await logActivity(user, "DELETE_ROOM", p.name, `Deleted room: ${p.name}`);
        }
        return res.status(200).json({ success: true });
      }

      case 'manageBrands': {
        if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden' });
        const subAction = params.subAction;
        const p = params.payload;

        if (subAction === 'CREATE') {
          await requestSupabase('POST', 'brands', { name: p.name, description: p.description, status: p.status });
          await logActivity(user, "CREATE_BRAND", p.name, `Created brand: ${p.name}`);
        } else if (subAction === 'UPDATE') {
          await requestSupabase('PATCH', `brands?name=eq.${encodeURIComponent(p.oldName)}`, { name: p.name, description: p.description, status: p.status });
          await logActivity(user, "UPDATE_BRAND", p.name, `Updated brand from ${p.oldName} to ${p.name}`);
        } else if (subAction === 'DELETE') {
          await requestSupabase('DELETE', `brands?name=eq.${encodeURIComponent(p.name)}`);
          await logActivity(user, "DELETE_BRAND", p.name, `Deleted brand: ${p.name}`);
        }
        return res.status(200).json({ success: true });
      }

      case 'manageUsers': {
        if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden' });
        const subAction = params.subAction;
        const p = params.payload;

        if (subAction === 'CREATE') {
          await requestSupabase('POST', 'users', { email: p.email, name: p.name, role: p.role, status: p.status, password: p.password });
          await logActivity(user, "CREATE_USER", p.email, `Created user: ${p.email} (${p.role})`);
        } else if (subAction === 'UPDATE') {
          await requestSupabase('PATCH', `users?email=eq.${encodeURIComponent(p.email)}`, { name: p.name, role: p.role, status: p.status, password: p.password });
          await logActivity(user, "UPDATE_USER", p.email, `Updated user details for: ${p.email}`);
        } else if (subAction === 'DELETE') {
          await requestSupabase('DELETE', `users?email=eq.${encodeURIComponent(p.email)}`);
          await logActivity(user, "DELETE_USER", p.email, `Deleted user: ${p.email}`);
        }
        return res.status(200).json({ success: true });
      }

      case 'manageRoles': {
        if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden' });
        const subAction = params.subAction;
        const p = params.payload;

        const dbRoleObj = {
          role_name: p.roleName,
          description: p.description || '',
          allowed_tabs: p.allowedTabs,
          can_create_booking: !!p.canCreateBooking,
          can_edit_booking: !!p.canEditBooking,
          can_cancel_booking: !!p.canCancelBooking,
          is_admin: !!p.isAdmin
        };

        if (subAction === 'CREATE') {
          await requestSupabase('POST', 'roles', dbRoleObj);
          await logActivity(user, "CREATE_ROLE", p.roleName, `Created role: ${p.roleName}`);
        } else if (subAction === 'UPDATE') {
          await requestSupabase('PATCH', `roles?role_name=eq.${encodeURIComponent(p.roleName)}`, dbRoleObj);
          await logActivity(user, "UPDATE_ROLE", p.roleName, `Updated role: ${p.roleName}`);
        } else if (subAction === 'DELETE') {
          await requestSupabase('DELETE', `roles?role_name=eq.${encodeURIComponent(p.roleName)}`);
          await logActivity(user, "DELETE_ROLE", p.roleName, `Deleted role: ${p.roleName}`);
        }
        return res.status(200).json({ success: true });
      }

      case 'getSystemSettings': {
        const settings = await requestSupabase('GET', 'settings');
        const dict = {};
        settings.forEach(s => dict[s.key] = s.value);
        return res.status(200).json({
          lineNotificationsEnabled: dict['line_notifications_enabled'] === 'true',
          lineChannelAccessToken: dict['line_channel_access_token'] || '',
          lineDestinationId: dict['line_destination_id'] || '',
          frontendUrl: dict['frontend_url'] || ''
        });
      }

      case 'saveSystemSettings': {
        if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden' });
        const dict = params.settings;

        const payloads = [
          { key: 'line_notifications_enabled', value: String(!!dict.lineNotificationsEnabled) },
          { key: 'line_channel_access_token', value: dict.lineChannelAccessToken || '' },
          { key: 'line_destination_id', value: dict.lineDestinationId || '' },
          { key: 'frontend_url', value: dict.frontendUrl || '' }
        ];

        // Perform multiple upserts using PostgREST resolution=merge-duplicates Prefer
        await requestSupabase('POST', 'settings', payloads, { 'Prefer': 'resolution=merge-duplicates' });
        await logActivity(user, "SAVE_SYSTEM_SETTINGS", "System", "Saved system settings configuration");
        
        return res.status(200).json({ success: true });
      }

      default:
        return res.status(400).json({ success: false, message: `Unknown action: ${action}` });
    }

  } catch (err) {
    console.error("API proxy execution error:", err);
    return res.status(500).json({ success: false, message: 'Database/Server error: ' + err.message });
  }
};
