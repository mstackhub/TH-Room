const https = require('https');

// Helper to make POST requests with redirect support (for GAS Web App)
function postRequest(url, data) {
  return new Promise((resolve, reject) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const parsedUrl = new URL(url);
    
    const options = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        // Follow redirect
        https.get(res.headers.location, (redirectRes) => {
          let body = '';
          redirectRes.on('data', chunk => body += chunk);
          redirectRes.on('end', () => {
            try { resolve(JSON.parse(body)); } catch(e) { resolve(body); }
          });
        }).on('error', reject);
      } else {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch(e) { resolve(body); }
        });
      }
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Helper to make requests to Supabase REST API
function postSupabase(supabaseUrl, supabaseKey, path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const url = new URL(`${supabaseUrl}/rest/v1/${path}`);
    
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Prefer': 'resolution=merge-duplicates'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, status: res.statusCode });
        } else {
          reject(new Error(`Supabase error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security check: require secret query param matching Vercel env or secret passphrase
  const secret = req.query.secret;
  if (!secret || secret !== 'migrate1234') {
    return res.status(403).json({ success: false, message: 'Forbidden. Invalid secret code.' });
  }

  const gasUrl = process.env.GAS_API_URL || "https://script.google.com/macros/s/AKfycbyUm0c2LCXIS9b76TsTmD7mWVzAuILkGa4HJUbHfoUDBBRflfVXAV26TBSgUYAFoqtX/exec";
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ success: false, message: 'Missing SUPABASE_URL or SUPABASE_KEY in Vercel environment variables.' });
  }

  try {
    console.log("Starting migration. Logging in to Google Apps Script...");
    
    // 1. Log in to get authentication token
    const loginRes = await postRequest(gasUrl, {
      action: 'login',
      email: 'masteradmin',
      password: 'Admin@1234'
    });

    if (!loginRes || !loginRes.token) {
      throw new Error("Failed to log in to Apps Script: " + JSON.stringify(loginRes));
    }

    const token = loginRes.token;
    console.log("Session token acquired. Fetching initial data...");

    // 2. Fetch all database data
    const dataRes = await postRequest(gasUrl, {
      action: 'getInitData',
      token: token
    });

    if (!dataRes || !dataRes.rooms || !dataRes.brands || !dataRes.allBookings) {
      throw new Error("Failed to fetch initial data: " + JSON.stringify(dataRes));
    }

    console.log("Data fetched. Mapping objects...");

    // 3. Map Rooms
    const roomsPayload = dataRes.rooms.map(r => ({
      name: r.name,
      description: r.description || '',
      status: r.status || 'Active'
    }));

    // 4. Map Brands
    const brandsPayload = dataRes.brands.map(b => ({
      name: b.name,
      description: b.description || '',
      status: b.status || 'Active'
    }));

    // 5. Map Roles
    const rolesList = dataRes.roles || [
      { roleName: 'Master Admin', description: 'Super administrator', allowedTabs: 'my-bookings,calendar,scheduler,campaign-schedule,analytics,rooms,brands,users,audit-log,settings,roles-mgmt', canCreateBooking: true, canEditBooking: true, canCancelBooking: true, isAdmin: true },
      { roleName: 'Campaign Manager', description: 'Manager for campaigns', allowedTabs: 'my-bookings,calendar,scheduler,campaign-schedule,analytics', canCreateBooking: true, canEditBooking: true, canCancelBooking: true, isAdmin: false },
      { roleName: 'Viewer', description: 'Read-only access', allowedTabs: 'my-bookings,calendar,scheduler,campaign-schedule,analytics', canCreateBooking: false, canEditBooking: false, canCancelBooking: false, isAdmin: false }
    ];
    const rolesPayload = rolesList.map(r => ({
      role_name: r.roleName,
      description: r.description || '',
      allowed_tabs: r.allowedTabs || 'my-bookings,calendar,scheduler,campaign-schedule,analytics',
      can_create_booking: String(r.canCreateBooking).toUpperCase() === 'TRUE' || r.canCreateBooking === true,
      can_edit_booking: String(r.canEditBooking).toUpperCase() === 'TRUE' || r.canEditBooking === true,
      can_cancel_booking: String(r.canCancelBooking).toUpperCase() === 'TRUE' || r.canCancelBooking === true,
      is_admin: String(r.isAdmin).toUpperCase() === 'TRUE' || r.isAdmin === true
    }));

    // 6. Map Users (using allUsersAdmin if available, or fall back to mock creator/viewer)
    const usersList = dataRes.allUsersAdmin || [
      { email: 'admin', name: 'System Admin', role: 'Master Admin', status: 'Active', password: 'admin1234' },
      { email: 'masteradmin', name: 'Master Admin', role: 'Master Admin', status: 'Active', password: 'Admin@1234' }
    ];
    const usersPayload = usersList.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role || 'Viewer',
      status: u.status || 'Active',
      password: u.password || '123456'
    }));

    // 7. Map Bookings
    const bookingsPayload = dataRes.allBookings.map(b => ({
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
    }));

    console.log("Uploading mapped data to Supabase...");

    // 8. Insert to Supabase tables
    if (roomsPayload.length > 0) {
      await postSupabase(supabaseUrl, supabaseKey, 'rooms', roomsPayload);
      console.log(`Successfully migrated ${roomsPayload.length} rooms.`);
    }

    if (brandsPayload.length > 0) {
      await postSupabase(supabaseUrl, supabaseKey, 'brands', brandsPayload);
      console.log(`Successfully migrated ${brandsPayload.length} brands.`);
    }

    if (rolesPayload.length > 0) {
      await postSupabase(supabaseUrl, supabaseKey, 'roles', rolesPayload);
      console.log(`Successfully migrated ${rolesPayload.length} roles.`);
    }

    if (usersPayload.length > 0) {
      // Clean roles in case a user references a role that doesn't exist (map to Viewer)
      const validRoles = new Set(rolesPayload.map(x => x.role_name.toLowerCase()));
      const cleanedUsersPayload = usersPayload.map(u => {
        if (!validRoles.has(u.role.toLowerCase())) {
          u.role = 'Viewer';
        }
        return u;
      });
      await postSupabase(supabaseUrl, supabaseKey, 'users', cleanedUsersPayload);
      console.log(`Successfully migrated ${usersPayload.length} users.`);
    }

    if (bookingsPayload.length > 0) {
      await postSupabase(supabaseUrl, supabaseKey, 'bookings', bookingsPayload);
      console.log(`Successfully migrated ${bookingsPayload.length} bookings.`);
    }

    console.log("Migration complete!");
    return res.status(200).json({
      success: true,
      message: 'Migration completed successfully!',
      stats: {
        rooms: roomsPayload.length,
        brands: brandsPayload.length,
        roles: rolesPayload.length,
        users: usersPayload.length,
        bookings: bookingsPayload.length
      }
    });

  } catch (err) {
    console.error("Migration failed:", err);
    return res.status(500).json({ success: false, message: 'Migration failed: ' + err.message });
  }
};
