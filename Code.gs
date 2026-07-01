/**
 * Live Studio Booking Management System - Backend API
 * File: Code.gs
 */

// CONSTANTS
var MASTER_PASSWORD_DEFAULT = "Admin@1234"; // Default password, user should change this
var BACKUP_FOLDER_NAME = "Studio_Booking_Backups";

/**
 * Convert a Google Sheets time cell to "HH:mm" string.
 * Sheets stores time-only values as a Date around 1899-12-30, so we just
 * extract hours & minutes directly from the object to avoid timezone shifts.
 * If the value is already a "HH:mm" string it is returned unchanged.
 */
var cachedSpreadsheetTimeZone = null;
function getSpreadsheetTimeZoneCached(ss) {
  if (cachedSpreadsheetTimeZone) return cachedSpreadsheetTimeZone;
  try {
    if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
    cachedSpreadsheetTimeZone = ss.getSpreadsheetTimeZone();
  } catch (e) {
    cachedSpreadsheetTimeZone = Session.getScriptTimeZone();
  }
  return cachedSpreadsheetTimeZone;
}

function formatTimeCell(val, ss) {
  if (!val && val !== 0) return "";
  if (val instanceof Date) {
    var tz = getSpreadsheetTimeZoneCached(ss);
    var yearStr = Utilities.formatDate(val, tz, "yyyy");
    var monthStr = Utilities.formatDate(val, tz, "MM");
    var dayStr = Utilities.formatDate(val, tz, "dd");
    var hourStr = Utilities.formatDate(val, tz, "HH");
    var minStr = Utilities.formatDate(val, tz, "mm");
    
    var h = parseInt(hourStr, 10);
    var m = parseInt(minStr, 10);
    var y = parseInt(yearStr, 10);
    var d = parseInt(dayStr, 10);
    var mo = parseInt(monthStr, 10);
    
    // Google Sheets stores time relative to 1899-12-30.
    // If the year is 1899 or 1900, we check the day to handle durations/times that cross midnight (like 24:00)
    if (y === 1899 || y === 1900) {
      if (d === 31) {
        h += 24;
      } else if (d === 1 && mo === 1) { // Jan 1st
        h += 48;
      }
    }
    
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  
  if (typeof val === "number") {
    var totalMins = Math.round(val * 24 * 60);
    var hh = Math.floor(totalMins / 60);
    var mm = totalMins % 60;
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  }
  
  var str = String(val).trim();
  var parts = str.split(":");
  if (parts.length >= 2) {
    var hh = parseInt(parts[0], 10);
    var mm = parseInt(parts[1], 10);
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  }
  return str;
}

/**
 * Main GET request handler
 */
function doGet(e) {
  return handleRequest(e, "GET");
}

/**
 * Main POST request handler
 */
function doPost(e) {
  // Check if it is a LINE webhook request
  if (e && e.postData && e.postData.contents) {
    try {
      var payload = JSON.parse(e.postData.contents);
      if (payload && payload.events) {
        return handleLineWebhook(payload);
      }
    } catch(err) {
      // Not a LINE webhook payload, continue to default handler
    }
  }
  return handleRequest(e, "POST");
}

/**
 * Route request and handle CORS
 */
function handleRequest(e, method) {
  var response = {};
  try {
    var params = {};
    var action = "";
    
    if (method === "GET") {
      params = e.parameter;
      action = params.action;
    } else { // POST
      // To support simple CORS requests, the content-type is text/plain.
      // So we parse the JSON string from e.postData.contents.
      var postData = {};
      if (e.postData && e.postData.contents) {
        postData = JSON.parse(e.postData.contents);
      }
      params = postData;
      action = params.action;
    }
    
    // Auto-initialize spreadsheets if needed (cached to speed up api requests)
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cache = CacheService.getScriptCache();
    var isInitialized = cache.get("spreadsheet_initialized");
    if (!isInitialized) {
      initSpreadsheet(ss);
      cache.put("spreadsheet_initialized", "true", 1800); // Cache for 30 minutes
    }
    
    if (!action) {
      throw new Error("Action parameter is required");
    }

    // 1. Authenticate user using custom session token or handle login action
    var user = null;
    if (action === "login") {
      response = loginUser(ss, params.email, params.password);
      response.success = true;
      return ContentService.createTextOutput(JSON.stringify(response))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var token = params.token;
    if (!token) {
      throw new Error("Authentication token is required");
    }
    
    var email = verifyCustomToken(ss, token);
    if (!email) {
      throw new Error("Invalid authentication token or session expired. Please log in again.");
    }
    
    user = getUserRecord(ss, email);
    if (!user) {
      throw new Error("User record not found in database: " + email);
    }
    
    if (user.status !== "Active") {
      throw new Error("User account is inactive. Please contact the administrator.");
    }
    
    // 2. Perform Routing
    switch (action) {
      // General APIs
      case "getInitData":
        response = getInitData(ss, user);
        break;
      case "getBookings":
        response = getBookings(ss, params.date);
        break;
      case "getMyBookings":
        response = getMyBookings(ss, user.email);
        break;
      case "getAllBookings":
        response = getAllBookings(ss);
        break;
        
      // Booking creation & modification
      case "createBooking":
        response = createBooking(ss, user, params.bookingData);
        break;
      case "updateBooking":
        response = updateBooking(ss, user, params.bookingId, params.bookingData);
        break;
      case "cancelBooking":
        response = cancelBooking(ss, user, params.bookingId);
        break;
        
      // Master Password verification
      case "verifyMasterPassword":
        response = verifyMasterPassword(ss, params.password);
        break;
        
      // Admin APIs (Require Master Admin)
      case "getActivityLogs":
        enforceAdmin(user);
        response = getActivityLogs(ss, params.password);
        break;
      case "manageUsers":
        enforceAdmin(user);
        response = manageUsers(ss, user, params.subAction, params.payload);
        break;
      case "manageRoles":
        enforceAdmin(user);
        response = manageRoles(ss, user, params.subAction, params.payload);
        break;
      case "manageRooms":
        enforceAdmin(user);
        response = manageRooms(ss, user, params.subAction, params.payload);
        break;
      case "manageBrands":
        enforceAdmin(user);
        response = manageBrands(ss, user, params.subAction, params.payload);
        break;
      case "changeMasterPassword":
        enforceAdmin(user);
        response = changeMasterPassword(ss, user, params.oldPassword, params.newPassword);
        break;
      case "manualBackup":
        enforceAdmin(user);
        runDailyBackup();
        response = { success: true, message: "Backup successfully completed!" };
        break;
      case "manualArchive":
        enforceAdmin(user);
        runYearlyArchive();
        response = { success: true, message: "Yearly archive successfully completed!" };
        break;
      case "getSystemSettings":
        enforceAdmin(user);
        response = getSystemSettings(user);
        break;
      case "saveSystemSettings":
        enforceAdmin(user);
        response = saveSystemSettings(user, params.settings);
        break;
        
      default:
        throw new Error("Unknown action: " + action);
    }
    
    response.success = true;
    
  } catch (error) {
    response.success = false;
    response.message = error.toString();
  }
  
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Verify Google ID Token
 */
function verifyGoogleToken(token) {
  if (token === "mock_test_token") {
    return {
      email: "admin.mock@company.com",
      name: "Local Dev Admin",
      picture: ""
    };
  }
  try {
    // In Google App Script, we can fetch tokeninfo endpoint to verify Google ID token
    var url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token);
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var responseCode = response.getResponseCode();
    var responseBody = response.getContentText();
    
    if (responseCode === 200) {
      var data = JSON.parse(responseBody);
      return {
        email: data.email,
        name: data.name || data.email.split('@')[0],
        picture: data.picture || ""
      };
    }
    
    // If it's a test environment token (Mock/Local development without standard token info, or expired)
    // We will throw error unless we want to bypass for local mock testing
    throw new Error("Google login verification failed: " + responseBody);
  } catch (e) {
    // Fallback: If url fetch fails or token expired, propagate error
    throw new Error("Failed to verify Google Token: " + e.message);
  }
}

/**
 * Enforce Master Admin role
 */
function enforceAdmin(user) {
  if (user.permissions && user.permissions.isAdmin) {
    return;
  }
  var role = String(user.role || '').trim().toLowerCase();
  if (role !== "master admin") {
    throw new Error("Permission Denied: Master Admin privilege required.");
  }
}

/**
 * Get User Record from sheet
 */
/**
 * Helper to fetch a role's permissions dynamically
 */
function getRolePermissionsGS(ss, roleName) {
  var defaultPermissions = {
    roleName: roleName,
    description: "",
    allowedTabs: "my-bookings,calendar,scheduler,campaign-schedule,analytics",
    canCreateBooking: false,
    canEditBooking: false,
    canCancelBooking: false,
    isAdmin: false
  };
  
  var roleLower = String(roleName || '').trim().toLowerCase();
  
  // Fallback defaults if Roles sheet is not yet initialized
  if (roleLower === "master admin") {
    defaultPermissions.allowedTabs = "my-bookings,calendar,scheduler,campaign-schedule,analytics,rooms,brands,users,audit-log,settings,roles-mgmt";
    defaultPermissions.canCreateBooking = true;
    defaultPermissions.canEditBooking = true;
    defaultPermissions.canCancelBooking = true;
    defaultPermissions.isAdmin = true;
  } else if (roleLower === "campaign manager") {
    defaultPermissions.canCreateBooking = true;
    defaultPermissions.canEditBooking = true;
    defaultPermissions.canCancelBooking = true;
  }
  
  var sheet = ss.getSheetByName("Roles");
  if (!sheet) return defaultPermissions;
  
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().toLowerCase().trim() === roleLower) {
      return {
        roleName: data[i][0],
        description: data[i][1],
        allowedTabs: data[i][2],
        canCreateBooking: String(data[i][3]).toUpperCase() === "TRUE",
        canEditBooking: String(data[i][4]).toUpperCase() === "TRUE",
        canCancelBooking: String(data[i][5]).toUpperCase() === "TRUE",
        isAdmin: String(data[i][6]).toUpperCase() === "TRUE"
      };
    }
  }
  
  return defaultPermissions;
}

/**
 * Get User Record from sheet
 */
function getUserRecord(ss, email) {
  var sheet = ss.getSheetByName("Users");
  if (sheet.getLastColumn() < 5) {
    sheet.getRange(1, 5).setValue("Password").setFontWeight("bold");
  }
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().toLowerCase().trim() === email.toLowerCase().trim()) {
      var role = data[i][2];
      var permissions = getRolePermissionsGS(ss, role);
      return {
        email: data[i][0],
        name: data[i][1],
        role: role,
        status: data[i][3],
        password: data[i].length > 4 ? data[i][4].toString() : "",
        permissions: permissions
      };
    }
  }
  return null;
}

/**
 * Check if Users sheet has no users
 */
function isUsersSheetEmpty(ss) {
  var sheet = ss.getSheetByName("Users");
  return sheet.getLastRow() <= 1;
}

/**
 * Add a User to database
 */
function addUserRecord(ss, email, name, role, status, password) {
  var sheet = ss.getSheetByName("Users");
  if (sheet.getLastColumn() < 5) {
    sheet.getRange(1, 5).setValue("Password").setFontWeight("bold");
  }
  var pwd = password || "123456";
  sheet.appendRow([email, name, role, status, pwd]);
  return {
    email: email,
    name: name,
    role: role,
    status: status
  };
}

/**
 * Fetch Initial Application Data (User details, Active Rooms, Active Brands)
 */
function getInitData(ss, user) {
  var roomsSheet = ss.getSheetByName("Rooms");
  var roomsData = roomsSheet.getDataRange().getValues();
  var rooms = [];
  var allRoomsAdmin = [];
  for (var i = 1; i < roomsData.length; i++) {
    var roomObj = {
      id: roomsData[i][0],
      name: roomsData[i][1],
      capacity: roomsData[i][2],
      description: roomsData[i][3],
      status: roomsData[i][4]
    };
    allRoomsAdmin.push(roomObj);
    if (roomsData[i][4] === "Active") { // Status
      rooms.push({
        id: roomObj.id,
        name: roomObj.name,
        capacity: roomObj.capacity,
        description: roomObj.description
      });
    }
  }
  
  var brandsSheet = ss.getSheetByName("Brands");
  var brandsData = brandsSheet.getDataRange().getValues();
  var brands = [];
  var allBrandsAdmin = [];
  for (var i = 1; i < brandsData.length; i++) {
    var brandObj = {
      id: brandsData[i][0],
      name: brandsData[i][1],
      status: brandsData[i][2],
      owner: brandsData[i][3] || ""
    };
    allBrandsAdmin.push(brandObj);
    if (brandsData[i][2] === "Active") { // Status
      brands.push({
        id: brandObj.id,
        name: brandObj.name,
        owner: brandObj.owner
      });
    }
  }
  
  var result = {
    user: user,
    rooms: rooms,
    brands: brands
  };

  if (String(user.role || '').trim().toLowerCase() === 'master admin') {
    result.allRoomsAdmin = allRoomsAdmin;
    result.allBrandsAdmin = allBrandsAdmin;
    
    var usersSheet = ss.getSheetByName("Users");
    var usersData = usersSheet.getDataRange().getValues();
    var allUsersAdmin = [];
    for (var i = 1; i < usersData.length; i++) {
      allUsersAdmin.push({
        email: usersData[i][0],
        name: usersData[i][1],
        role: usersData[i][2],
        status: usersData[i][3]
      });
    }
    result.allUsersAdmin = allUsersAdmin;
  }
  
  // Load roles list for all sessions
  var rolesSheet = ss.getSheetByName("Roles");
  var allRoles = [];
  if (rolesSheet) {
    var rolesData = rolesSheet.getDataRange().getValues();
    for (var i = 1; i < rolesData.length; i++) {
      allRoles.push({
        roleName: rolesData[i][0],
        description: rolesData[i][1],
        allowedTabs: rolesData[i][2],
        canCreateBooking: String(rolesData[i][3]).toUpperCase() === "TRUE",
        canEditBooking: String(rolesData[i][4]).toUpperCase() === "TRUE",
        canCancelBooking: String(rolesData[i][5]).toUpperCase() === "TRUE",
        isAdmin: String(rolesData[i][6]).toUpperCase() === "TRUE"
      });
    }
  }
  result.allRoles = allRoles;
  
  try {
    var allBookingsResult = getAllBookings(ss);
    result.allBookings = allBookingsResult.bookings;
  } catch (e) {
    result.allBookings = [];
  }
  
  return result;
}

/**
 * Get bookings for a specific date
 */
function getBookings(ss, dateStr) {
  var tz = getSpreadsheetTimeZoneCached(ss);
  if (!dateStr) {
    dateStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  }
  
  // --- CacheService: cache per-date for 60 seconds to reduce Sheet reads ---
  var cache = CacheService.getScriptCache();
  var cacheKey = "bookings_" + dateStr;
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  var bookings = [];
  
  for (var i = 1; i < data.length; i++) {
    // Index mapping:
    // 0:BookingID, 1:BrandName, 2:CampaignName, 3:RoomName, 4:Date, 5:StartTime, 6:EndTime, 7:Remark, 8:OwnerEmail, 9:OwnerName, 10:Status, 11:CreatedAt, 12:BriefText, 13:BriefLink, 14:LSArtworkLayout
    if (!data[i][0]) continue;
    var bDate = Utilities.formatDate(new Date(data[i][4]), tz, "yyyy-MM-dd");
    if (bDate === dateStr) {
      bookings.push({
        id: data[i][0],
        brandName: data[i][1],
        campaignName: data[i][2],
        roomName: data[i][3],
        date: bDate,
        startTime: formatTimeCell(data[i][5], ss),
        endTime: formatTimeCell(data[i][6], ss),
        remark: data[i][7],
        ownerEmail: data[i][8],
        ownerName: data[i][9],
        status: data[i][10],
        briefText: data[i][12] || "",
        briefLink: data[i][13] || "",
        lsArtworkLayout: data[i][14] || "",
        roomId: data[i].length > 15 ? data[i][15] : ""
      });
    }
  }
  var result = { bookings: bookings, date: dateStr };
  cache.put(cacheKey, JSON.stringify(result), 60); // cache 60 sec
  return result;
}

/**
 * Get all bookings for a user
 */
function getMyBookings(ss, email) {
  // --- CacheService: per-user cache for 30 seconds ---
  var cache = CacheService.getScriptCache();
  var cacheKey = "mybookings_" + email.toLowerCase().replace(/[^a-z0-9]/g, "_");
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  var bookings = [];
  var tz = getSpreadsheetTimeZoneCached(ss);
  
  for (var i = data.length - 1; i >= 1; i--) { // Reverse order to get recent first
    if (!data[i][0]) continue;
    if (data[i][8].toString().toLowerCase() === email.toLowerCase()) {
      var bDate = Utilities.formatDate(new Date(data[i][4]), tz, "yyyy-MM-dd");
      bookings.push({
        id: data[i][0],
        brandName: data[i][1],
        campaignName: data[i][2],
        roomName: data[i][3],
        date: bDate,
        startTime: formatTimeCell(data[i][5], ss),
        endTime: formatTimeCell(data[i][6], ss),
        remark: data[i][7],
        ownerEmail: data[i][8],
        ownerName: data[i][9],
        status: data[i][10],
        briefText: data[i][12] || "",
        briefLink: data[i][13] || "",
        lsArtworkLayout: data[i][14] || "",
        roomId: data[i].length > 15 ? data[i][15] : ""
      });
    }
  }
  var result = { bookings: bookings };
  cache.put(cacheKey, JSON.stringify(result), 30); // cache 30 sec
  return result;
}

/**
 * Get all bookings (for Calendar & Analytics views)
 */
function getAllBookings(ss) {
  // --- CacheService: cache all bookings for 30 seconds ---
  var cache = CacheService.getScriptCache();
  var cacheKey = "allbookings";
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  var bookings = [];
  var tz = getSpreadsheetTimeZoneCached(ss);
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) { // Check if Booking ID is present
      var bDate = Utilities.formatDate(new Date(data[i][4]), tz, "yyyy-MM-dd");
      bookings.push({
        id: data[i][0],
        brandName: data[i][1],
        campaignName: data[i][2],
        roomName: data[i][3],
        date: bDate,
        startTime: formatTimeCell(data[i][5], ss),
        endTime: formatTimeCell(data[i][6], ss),
        remark: data[i][7],
        ownerEmail: data[i][8],
        ownerName: data[i][9],
        status: data[i][10],
        briefText: data[i][12] || "",
        briefLink: data[i][13] || "",
        lsArtworkLayout: data[i][14] || "",
        roomId: data[i].length > 15 ? data[i][15] : ""
      });
    }
  }
  var result = { bookings: bookings };
  cache.put(cacheKey, JSON.stringify(result), 30);
  return result;
}

/**
 * Check if a room has pending or active bookings
 */
function hasPendingBookingsForRoomGS(ss, roomId, roomName) {
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  var timeZone = getSpreadsheetTimeZoneCached(ss);
  var todayStr = Utilities.formatDate(now, timeZone, "yyyy-MM-dd");
  
  var hourStr = Utilities.formatDate(now, timeZone, "HH");
  var minStr = Utilities.formatDate(now, timeZone, "mm");
  var currentMins = parseInt(hourStr, 10) * 60 + parseInt(minStr, 10);
  
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    
    var bRoomName = data[i][3];
    var bRoomId = data[i].length > 15 ? data[i][15] : "";
    var bStatus = data[i][10];
    
    var isMatch = false;
    if (bRoomId && roomId) {
      isMatch = (bRoomId === roomId);
    } else {
      isMatch = (bRoomName === roomName);
    }
    
    if (isMatch && bStatus === "Confirmed") {
      var bDateStr;
      try {
        bDateStr = Utilities.formatDate(new Date(data[i][4]), timeZone, "yyyy-MM-dd");
      } catch (e) {
        continue;
      }
      
      var bEndTime = formatTimeCell(data[i][6], ss);
      var bEndMins = parseTimeToMinutes(bEndTime, ss);
      
      if (bDateStr > todayStr) {
        return true;
      } else if (bDateStr === todayStr && bEndMins > currentMins) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a brand has any pending or active bookings (upcoming/in-progress)
 */
function hasPendingBookingsForBrandGS(ss, brandName) {
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  var timeZone = getSpreadsheetTimeZoneCached(ss);
  var todayStr = Utilities.formatDate(now, timeZone, "yyyy-MM-dd");
  
  var hourStr = Utilities.formatDate(now, timeZone, "HH");
  var minStr = Utilities.formatDate(now, timeZone, "mm");
  var currentMins = parseInt(hourStr, 10) * 60 + parseInt(minStr, 10);
  
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    
    var bBrandName = data[i][1];
    var bStatus = data[i][10];
    
    if (bBrandName && bBrandName.toString().trim().toLowerCase() === brandName.toString().trim().toLowerCase() && bStatus === "Confirmed") {
      var bDateStr;
      try {
        bDateStr = Utilities.formatDate(new Date(data[i][4]), timeZone, "yyyy-MM-dd");
      } catch (e) {
        continue;
      }
      
      var bEndTime = formatTimeCell(data[i][6], ss);
      var bEndMins = parseTimeToMinutes(bEndTime, ss);
      
      if (bDateStr > todayStr) {
        return true;
      } else if (bDateStr === todayStr && bEndMins > currentMins) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check for scheduling conflicts
 */
function hasConflict(ss, roomName, dateStr, startTime, endTime, excludeBookingId) {
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  
  var newStart = parseTimeToMinutes(startTime, ss);
  var newEnd = parseTimeToMinutes(endTime, ss);
  
  if (newStart >= newEnd) {
    throw new Error("Start time must be before End time.");
  }
  
  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (!id) continue;
    var bRoom = data[i][3];
    if (!bRoom || !data[i][4]) continue;
    
    var bDate;
    try {
      bDate = Utilities.formatDate(new Date(data[i][4]), getSpreadsheetTimeZoneCached(ss), "yyyy-MM-dd");
    } catch (e) {
      continue;
    }
    
    var bStatus = data[i][10];
    
    if (id !== excludeBookingId && bRoom === roomName && bDate === dateStr && bStatus !== "Cancelled") {
      if (!data[i][5] || !data[i][6]) continue;
      var extStart = parseTimeToMinutes(data[i][5], ss);
      var extEnd = parseTimeToMinutes(data[i][6], ss);
      
      // Conflict condition: (newStart < extEnd) && (newEnd > extStart)
      if (newStart < extEnd && newEnd > extStart) {
        return true; // Overlap detected
      }
    }
  }
  return false;
}

function parseTimeToMinutes(timeStr, ss) {
  // Parses HH:MM or Date-formatted strings into minutes from midnight
  if (timeStr instanceof Date) {
    var tz = getSpreadsheetTimeZoneCached(ss);
    var yearStr = Utilities.formatDate(timeStr, tz, "yyyy");
    var monthStr = Utilities.formatDate(timeStr, tz, "MM");
    var dayStr = Utilities.formatDate(timeStr, tz, "dd");
    var hourStr = Utilities.formatDate(timeStr, tz, "HH");
    var minStr = Utilities.formatDate(timeStr, tz, "mm");
    
    var h = parseInt(hourStr, 10);
    var m = parseInt(minStr, 10);
    var y = parseInt(yearStr, 10);
    var d = parseInt(dayStr, 10);
    var mo = parseInt(monthStr, 10);
    
    if (y === 1899 || y === 1900) {
      if (d === 31) {
        h += 24;
      } else if (d === 1 && mo === 1) {
        h += 48;
      }
    }
    return h * 60 + m;
  }
  if (typeof timeStr === "number") {
    return Math.round(timeStr * 24 * 60);
  }
  var parts = timeStr.toString().split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/**
 * Create a Booking
 */
function createBooking(ss, user, bData) {
  // Enforce create permission dynamically
  var canCreate = user.permissions ? user.permissions.canCreateBooking : true;
  var role = String(user.role || '').trim().toLowerCase();
  if (role === "viewer" || role === "admin") { // fallback legacy
    canCreate = false;
  }
  if (!canCreate) {
    throw new Error("Permission Denied: Your account does not have permission to create bookings.");
  }
  
  // Validate input
  if (!bData.brandName || !bData.campaignName || !bData.roomName || !bData.date || !bData.startTime || !bData.endTime) {
    throw new Error("Missing required booking fields.");
  }
  
  // Format dates & strings
  var dateStr = Utilities.formatDate(new Date(bData.date), getSpreadsheetTimeZoneCached(ss), "yyyy-MM-dd");
  
  // Conflict verification
  if (hasConflict(ss, bData.roomName, dateStr, bData.startTime, bData.endTime, "")) {
    throw new Error("ห้องนี้ถูกจองในช่วงเวลาดังกล่าวแล้ว (Scheduling conflict)");
  }
  
  var sheet = ss.getSheetByName("Bookings");
  var bookingId = "BK_" + new Date().getTime() + "_" + Math.floor(Math.random() * 1000);
  var createdAt = new Date();
  
  // Automatically create Google Drive folder for this session
  var folderUrl = "";
  try {
    folderUrl = createSessionDriveFolder(bData.brandName, dateStr, bData.startTime, bData.campaignName);
  } catch (err) {
    Logger.log("Folder creation failed on createBooking: " + err.toString());
  }
  
  // Parse and prepend the auto-generated Google Drive folder to lsArtworkLayout
  var artworkLayout = bData.lsArtworkLayout || "";
  var artworkList = [];
  if (artworkLayout) {
    try {
      artworkList = JSON.parse(artworkLayout);
    } catch (e) {
      if (artworkLayout.trim() !== "") {
        artworkList = [{ type: "Other", url: artworkLayout.trim() }];
      }
    }
  }
  if (folderUrl) {
    // Unshift to place Google Drive as the first primary link
    artworkList.unshift({ type: "Google Drive", url: folderUrl });
  }
  artworkLayout = artworkList.length > 0 ? JSON.stringify(artworkList) : "";
  
  sheet.appendRow([
    bookingId,
    bData.brandName,
    bData.campaignName,
    bData.roomName,
    dateStr,
    bData.startTime,
    bData.endTime,
    bData.remark || "",
    user.email,
    user.name,
    "Confirmed", // default status
    createdAt,
    bData.briefText || "",
    bData.briefLink || "",
    artworkLayout,
    bData.roomId || ""
  ]);
  
  SpreadsheetApp.flush(); // Flush spreadsheet changes immediately to avoid read-after-write delays
  
  var logText = Utilities.formatString(
    "Created Booking: Room %s, Date %s, Time %s-%s, Brand %s, Campaign %s",
    bData.roomName, dateStr, bData.startTime, bData.endTime, bData.brandName, bData.campaignName
  );
  
  logActivity(ss, user.email, user.name, "CREATE_BOOKING", "-", logText, bData.ip || "-", bData.device || "-");
  
  // Invalidate caches so next read fetches fresh data
  try {
    var cache = CacheService.getScriptCache();
    cache.remove("bookings_" + dateStr);
    cache.remove("allbookings");
    cache.remove("mybookings_" + user.email.toLowerCase().replace(/[^a-z0-9]/g, "_"));
  } catch(e) {}
  
  // Trigger LINE message
  try {
    var bookingObjForLine = {
      brandName: bData.brandName,
      campaignName: bData.campaignName,
      roomName: bData.roomName,
      date: dateStr,
      startTime: bData.startTime,
      endTime: bData.endTime,
      remark: bData.remark,
      ownerName: user.name,
      briefLink: bData.briefLink,
      lsArtworkLayout: artworkLayout
    };
    sendLineFlexMessage(bookingObjForLine, "CREATE");
  } catch(err) {
    Logger.log("Failed to send LINE creation alert: " + err.toString());
  }
  
  return { success: true, bookingId: bookingId };
}

/**
 * Update an existing Booking
 */
function updateBooking(ss, user, bookingId, bData) {
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  var rowIndex = -1;
  var oldRecord = null;
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === bookingId) {
      rowIndex = i + 1; // 1-based index including headers
      var bDate = Utilities.formatDate(new Date(data[i][4]), getSpreadsheetTimeZoneCached(ss), "yyyy-MM-dd");
      oldRecord = {
        brandName: data[i][1],
        campaignName: data[i][2],
        roomName: data[i][3],
        date: bDate,
        startTime: formatTimeCell(data[i][5], ss),
        endTime: formatTimeCell(data[i][6], ss),
        remark: data[i][7],
        ownerEmail: data[i][8],
        ownerName: data[i][9],
        status: data[i][10],
        briefText: data[i][12] || "",
        briefLink: data[i][13] || "",
        lsArtworkLayout: data[i][14] || ""
      };
      break;
    }
  }
  
  if (rowIndex === -1) {
    throw new Error("Booking not found: " + bookingId);
  }
  
  // Enforce edit permission dynamically
  var canEdit = user.permissions ? user.permissions.canEditBooking : true;
  var role = String(user.role || '').trim().toLowerCase();
  if (role === "viewer" || role === "admin") { // fallback legacy
    canEdit = false;
  }
  if (!canEdit) {
    throw new Error("Permission Denied: Your account does not have permission to edit bookings.");
  }
  
  var isAdmin = user.permissions ? user.permissions.isAdmin : (role === "master admin");
  
  // Settle permissions: Only the booking owner or Admin can edit
  if (!isAdmin && oldRecord.ownerEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new Error("You do not have permission to edit this booking.");
  }
  
  // Non-admins cannot edit completed or cancelled bookings
  if (!isAdmin && (oldRecord.status === "Completed" || oldRecord.status === "Cancelled")) {
    throw new Error("Only administrators can edit Completed or Cancelled bookings.");
  }
  
  var dateStr = Utilities.formatDate(new Date(bData.date), getSpreadsheetTimeZoneCached(ss), "yyyy-MM-dd");
  
  // Conflict validation (ignore self)
  if (bData.status !== "Cancelled" && hasConflict(ss, bData.roomName, dateStr, bData.startTime, bData.endTime, bookingId)) {
    throw new Error("ห้องนี้ถูกจองในช่วงเวลาดังกล่าวแล้ว (Scheduling conflict)");
  }
  
  // Perform update in sheet
  // Col indexing: 1:BrandName, 2:CampaignName, 3:RoomName, 4:Date, 5:StartTime, 6:EndTime, 7:Remark, 8:OwnerEmail, 9:OwnerName, 10:Status
  sheet.getRange(rowIndex, 2).setValue(bData.brandName);
  sheet.getRange(rowIndex, 3).setValue(bData.campaignName);
  sheet.getRange(rowIndex, 4).setValue(bData.roomName);
  sheet.getRange(rowIndex, 5).setValue(dateStr);
  sheet.getRange(rowIndex, 6).setValue(bData.startTime);
  sheet.getRange(rowIndex, 7).setValue(bData.endTime);
  sheet.getRange(rowIndex, 8).setValue(bData.remark || "");
  sheet.getRange(rowIndex, 13).setValue(bData.briefText || "");
  sheet.getRange(rowIndex, 14).setValue(bData.briefLink || "");
  sheet.getRange(rowIndex, 15).setValue(bData.lsArtworkLayout || "");
  
  if (bData.roomId) {
    sheet.getRange(rowIndex, 16).setValue(bData.roomId);
  }
  
  if (bData.status) {
    sheet.getRange(rowIndex, 11).setValue(bData.status);
  }
  
  SpreadsheetApp.flush(); // Flush spreadsheet changes immediately to avoid read-after-write delays
  
  // Logging changes
  var beforeText = Utilities.formatString(
    "Room: %s, Date: %s, Time: %s-%s, Brand: %s, Campaign: %s, Status: %s, BriefText: %s, BriefLink: %s, LSArtworkLayout: %s",
    oldRecord.roomName, oldRecord.date, oldRecord.startTime, oldRecord.endTime, oldRecord.brandName, oldRecord.campaignName, oldRecord.status, oldRecord.briefText, oldRecord.briefLink, oldRecord.lsArtworkLayout
  );
  var afterText = Utilities.formatString(
    "Room: %s, Date: %s, Time: %s-%s, Brand: %s, Campaign: %s, Status: %s, BriefText: %s, BriefLink: %s, LSArtworkLayout: %s",
    bData.roomName, dateStr, bData.startTime, bData.endTime, bData.brandName, bData.campaignName, bData.status || oldRecord.status, bData.briefText || "", bData.briefLink || "", bData.lsArtworkLayout || ""
  );
  
  logActivity(ss, user.email, user.name, "EDIT_BOOKING", beforeText, afterText, bData.ip || "-", bData.device || "-");
  
  // Invalidate caches
  try {
    var cache = CacheService.getScriptCache();
    cache.remove("bookings_" + dateStr);
    cache.remove("bookings_" + oldRecord.date);
    cache.remove("allbookings");
    cache.remove("mybookings_" + user.email.toLowerCase().replace(/[^a-z0-9]/g, "_"));
    if (oldRecord && oldRecord.ownerEmail) {
      cache.remove("mybookings_" + oldRecord.ownerEmail.toLowerCase().replace(/[^a-z0-9]/g, "_"));
    }
  } catch(e) {}
  
  // Trigger LINE message
  try {
    var bookingObjForLine = {
      brandName: bData.brandName,
      campaignName: bData.campaignName,
      roomName: bData.roomName,
      date: dateStr,
      startTime: bData.startTime,
      endTime: bData.endTime,
      remark: bData.remark,
      ownerName: oldRecord.ownerName,
      briefLink: bData.briefLink,
      lsArtworkLayout: bData.lsArtworkLayout
    };
    if (bData.status === "Cancelled") {
      sendLineFlexMessage(bookingObjForLine, "CANCEL");
    } else {
      sendLineFlexMessage(bookingObjForLine, "UPDATE");
    }
  } catch(err) {
    Logger.log("Failed to send LINE update alert: " + err.toString());
  }
  
  return { success: true };
}

/**
 * Cancel a Booking (Soft Delete)
 */
function cancelBooking(ss, user, bookingId) {
  var sheet = ss.getSheetByName("Bookings");
  var data = sheet.getDataRange().getValues();
  var rowIndex = -1;
  var oldRecord = null;
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === bookingId) {
      rowIndex = i + 1;
      oldRecord = {
        brandName: data[i][1],
        campaignName: data[i][2],
        roomName: data[i][3],
        date: Utilities.formatDate(new Date(data[i][4]), getSpreadsheetTimeZoneCached(ss), "yyyy-MM-dd"),
        startTime: formatTimeCell(data[i][5], ss),
        endTime: formatTimeCell(data[i][6], ss),
        ownerEmail: data[i][8],
        status: data[i][10]
      };
      break;
    }
  }
  
  if (rowIndex === -1) {
    throw new Error("Booking not found");
  }
  
  // Enforce cancel permission dynamically
  var canCancel = user.permissions ? user.permissions.canCancelBooking : true;
  var role = String(user.role || '').trim().toLowerCase();
  if (role === "viewer" || role === "admin") { // fallback legacy
    canCancel = false;
  }
  if (!canCancel) {
    throw new Error("Permission Denied: Your account does not have permission to cancel bookings.");
  }
  
  var isAdmin = user.permissions ? user.permissions.isAdmin : (role === "master admin");
  
  // Settle permissions
  if (!isAdmin && oldRecord.ownerEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new Error("You do not have permission to cancel this booking.");
  }
  
  sheet.getRange(rowIndex, 11).setValue("Cancelled");
  
  SpreadsheetApp.flush(); // Flush spreadsheet changes immediately to avoid read-after-write delays
  
  var logText = Utilities.formatString(
    "Booking ID: %s, Room: %s, Date: %s, Time: %s-%s, Brand: %s, Campaign: %s",
    bookingId,
    oldRecord.roomName,
    oldRecord.date,
    oldRecord.startTime,
    oldRecord.endTime,
    oldRecord.brandName,
    oldRecord.campaignName
  );
  logActivity(ss, user.email, user.name, "DELETE_BOOKING", logText, "Status: Cancelled", "-", "-");
  
  // Invalidate caches
  try {
    var cache = CacheService.getScriptCache();
    cache.remove("bookings_" + oldRecord.date);
    cache.remove("allbookings");
    cache.remove("mybookings_" + user.email.toLowerCase().replace(/[^a-z0-9]/g, "_"));
    if (oldRecord && oldRecord.ownerEmail) {
      cache.remove("mybookings_" + oldRecord.ownerEmail.toLowerCase().replace(/[^a-z0-9]/g, "_"));
    }
  } catch(e) {}
  
  // Trigger LINE message
  try {
    var bookingObjForLine = {
      brandName: "-",
      campaignName: "-",
      roomName: oldRecord.roomName,
      date: oldRecord.date,
      startTime: oldRecord.startTime,
      endTime: oldRecord.endTime,
      remark: "Cancelled by " + user.name,
      ownerName: "-",
      briefLink: "",
      lsArtworkLayout: ""
    };
    sendLineFlexMessage(bookingObjForLine, "CANCEL");
  } catch(err) {
    Logger.log("Failed to send LINE cancellation alert: " + err.toString());
  }
  
  return { success: true };
}

/**
 * Verify Master Password
 */
function verifyMasterPassword(ss, password) {
  var storedHash = getMasterPasswordHash(ss);
  var inputHash = hashSHA256(password);
  return { success: true, verified: (storedHash === inputHash) };
}

/**
 * Change Master Password
 */
function changeMasterPassword(ss, user, oldPassword, newPassword) {
  var storedHash = getMasterPasswordHash(ss);
  var oldInputHash = hashSHA256(oldPassword);
  
  if (storedHash !== oldInputHash) {
    throw new Error("Incorrect current Master Password.");
  }
  
  var newHash = hashSHA256(newPassword);
  setMasterPasswordHash(ss, newHash);
  
  logActivity(ss, user.email, user.name, "CHANGE_MASTER_PASSWORD", "-", "Hashed password updated", "-", "-");
  return { success: true, message: "Password updated successfully." };
}

/**
 * Get Activity Logs (Protected by Master Password)
 */
function getActivityLogs(ss, password) {
  // Validate master password
  var storedHash = getMasterPasswordHash(ss);
  var inputHash = hashSHA256(password);
  
  if (storedHash !== inputHash) {
    throw new Error("Unauthorized: Invalid Master Password.");
  }
  
  var sheet = ss.getSheetByName("ActivityLog");
  var data = sheet.getDataRange().getValues();
  var logs = [];
  
  // Return logs in reverse chronological order, limit to last 1000 rows
  var limit = Math.max(1, data.length - 1000);
  for (var i = data.length - 1; i >= limit; i--) {
    logs.push({
      timestamp: Utilities.formatDate(new Date(data[i][0]), getSpreadsheetTimeZoneCached(ss), "yyyy-MM-dd HH:mm:ss"),
      userEmail: data[i][1],
      userName: data[i][2],
      action: data[i][3],
      before: data[i][4],
      after: data[i][5],
      ip: data[i][6],
      device: data[i][7]
    });
  }
  
  return { logs: logs };
}

/**
 * Admin Panel Management: ROLES
 */
function manageRoles(ss, adminUser, subAction, payload) {
  var sheet = ss.getSheetByName("Roles");
  if (!sheet) {
    throw new Error("Roles sheet not initialized.");
  }
  var data = sheet.getDataRange().getValues();
  
  if (subAction === "list") {
    var rolesList = [];
    for (var i = 1; i < data.length; i++) {
      rolesList.push({
        roleName: data[i][0],
        description: data[i][1],
        allowedTabs: data[i][2],
        canCreateBooking: String(data[i][3]).toUpperCase() === "TRUE",
        canEditBooking: String(data[i][4]).toUpperCase() === "TRUE",
        canCancelBooking: String(data[i][5]).toUpperCase() === "TRUE",
        isAdmin: String(data[i][6]).toUpperCase() === "TRUE"
      });
    }
    return { roles: rolesList };
  }
  
  if (subAction === "add") {
    var newRoleName = String(payload.roleName).trim();
    if (!newRoleName) throw new Error("Role Name is required.");
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase().trim() === newRoleName.toLowerCase()) {
        throw new Error("Role already exists.");
      }
    }
    sheet.appendRow([
      newRoleName,
      payload.description || "",
      payload.allowedTabs || "my-bookings,calendar,scheduler,campaign-schedule,analytics",
      payload.canCreateBooking ? "TRUE" : "FALSE",
      payload.canEditBooking ? "TRUE" : "FALSE",
      payload.canCancelBooking ? "TRUE" : "FALSE",
      payload.isAdmin ? "TRUE" : "FALSE"
    ]);
    logActivity(ss, adminUser.email, adminUser.name, "ADD_ROLE", "-", "Role: " + newRoleName, "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "edit") {
    var rowIndex = -1;
    var targetRoleName = String(payload.roleName).trim();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase().trim() === targetRoleName.toLowerCase()) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) throw new Error("Role not found.");
    
    // Protect Master Admin from losing admin or critical tabs privileges
    var isMasterAdmin = targetRoleName.toLowerCase() === "master admin";
    var finalIsAdmin = isMasterAdmin ? "TRUE" : (payload.isAdmin ? "TRUE" : "FALSE");
    var finalAllowedTabs = isMasterAdmin ? "my-bookings,calendar,scheduler,campaign-schedule,analytics,rooms,brands,users,audit-log,settings,roles-mgmt" : (payload.allowedTabs || "my-bookings,calendar,scheduler,campaign-schedule,analytics");
    
    var rowValues = [[
      payload.description || "",
      finalAllowedTabs,
      payload.canCreateBooking ? "TRUE" : "FALSE",
      payload.canEditBooking ? "TRUE" : "FALSE",
      payload.canCancelBooking ? "TRUE" : "FALSE",
      finalIsAdmin
    ]];
    sheet.getRange(rowIndex, 2, 1, 6).setValues(rowValues);
    
    logActivity(ss, adminUser.email, adminUser.name, "EDIT_ROLE", "Role: " + targetRoleName, "Updated permissions", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "delete") {
    var rowIndex = -1;
    var targetRoleName = String(payload.roleName).trim();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase().trim() === targetRoleName.toLowerCase()) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) throw new Error("Role not found.");
    
    // Protect Master Admin system role
    if (targetRoleName.toLowerCase() === "master admin") {
      throw new Error("Cannot delete Master Admin role.");
    }
    
    sheet.deleteRow(rowIndex);
    logActivity(ss, adminUser.email, adminUser.name, "DELETE_ROLE", "Role: " + targetRoleName, "-", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  throw new Error("Sub-action not supported: " + subAction);
}

/**
 * Admin Panel Management: USERS
 */
function manageUsers(ss, adminUser, subAction, payload) {
  var sheet = ss.getSheetByName("Users");
  var data = sheet.getDataRange().getValues();
  
  if (subAction === "list") {
    var usersList = [];
    for (var i = 1; i < data.length; i++) {
      usersList.push({
        email: data[i][0],
        name: data[i][1],
        role: data[i][2],
        status: data[i][3],
        password: data[i].length > 4 ? data[i][4].toString() : ""
      });
    }
    return { users: usersList };
  }
  
  if (subAction === "add") {
    // check existence
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase() === payload.email.toLowerCase()) {
        throw new Error("User email already exists.");
      }
    }
    if (sheet.getLastColumn() < 5) {
      sheet.getRange(1, 5).setValue("Password").setFontWeight("bold");
    }
    var pwd = payload.password || "123456";
    sheet.appendRow([payload.email, payload.name, payload.role, "Active", pwd]);
    logActivity(ss, adminUser.email, adminUser.name, "ADD_USER", "-", "User: " + payload.email + " (" + payload.role + ")", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "edit") {
    var rowIndex = -1;
    var beforeVal = "";
    
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase() === payload.email.toLowerCase()) {
        rowIndex = i + 1;
        beforeVal = "Role: " + data[i][2] + ", Status: " + data[i][3];
        break;
      }
    }
    
    if (rowIndex === -1) throw new Error("User not found.");
    
    // Prevent self-lockout/role demotion of logged in admin
    if (payload.email.toLowerCase() === adminUser.email.toLowerCase() && payload.role !== "Master Admin") {
      throw new Error("You cannot change your own role to prevent lockout.");
    }
    
    var cols = [payload.name, payload.role, payload.status];
    if (payload.password) {
      if (sheet.getLastColumn() < 5) {
        sheet.getRange(1, 5).setValue("Password").setFontWeight("bold");
      }
      cols.push(payload.password);
    }
    sheet.getRange(rowIndex, 2, 1, cols.length).setValues([cols]);
    
    var afterVal = "Role: " + payload.role + ", Status: " + payload.status;
    logActivity(ss, adminUser.email, adminUser.name, "EDIT_USER", beforeVal, afterVal, "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "delete") {
    var rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase() === payload.email.toLowerCase()) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) throw new Error("User not found.");
    
    // Prevent self-deletion
    if (payload.email.toLowerCase() === adminUser.email.toLowerCase()) {
      throw new Error("You cannot delete your own user account.");
    }
    
    var userEmail = data[rowIndex-1][0];
    sheet.deleteRow(rowIndex);
    logActivity(ss, adminUser.email, adminUser.name, "DELETE_USER", "User: " + userEmail, "-", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
}

/**
 * Admin Panel Management: ROOMS
 */
function manageRooms(ss, adminUser, subAction, payload) {
  var sheet = ss.getSheetByName("Rooms");
  var data = sheet.getDataRange().getValues();
  
  if (subAction === "list") {
    var roomsList = [];
    for (var i = 1; i < data.length; i++) {
      roomsList.push({
        id: data[i][0],
        name: data[i][1],
        capacity: data[i][2],
        description: data[i][3],
        status: data[i][4]
      });
    }
    return { rooms: roomsList };
  }
  
  if (subAction === "add") {
    // Check for duplicate name
    for (var i = 1; i < data.length; i++) {
      if (data[i][1].toString().trim().toLowerCase() === payload.name.toString().trim().toLowerCase()) {
        throw new Error("ชื่อห้องนี้มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น!");
      }
    }
    var newId = "RM_" + (data.length + 100);
    sheet.appendRow([newId, payload.name, payload.capacity, payload.description, "Active"]);
    logActivity(ss, adminUser.email, adminUser.name, "ADD_ROOM", "-", "Room: " + payload.name, "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "edit") {
    // Check for duplicate name (excluding the current room ID)
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] !== payload.id && data[i][1].toString().trim().toLowerCase() === payload.name.toString().trim().toLowerCase()) {
        throw new Error("ชื่อห้องนี้มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น!");
      }
    }
    var rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === payload.id) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) throw new Error("Room not found");
    
    var oldName = data[rowIndex-1][1];
    
    if (payload.status === "Inactive") {
      if (hasPendingBookingsForRoomGS(ss, payload.id, oldName)) {
        throw new Error("ไม่สามารถปิดใช้งานห้องได้ (Inactive) เนื่องจากยังมีรอบไลฟ์ของห้องนี้รอค้างอยู่");
      }
    }
    
    sheet.getRange(rowIndex, 2).setValue(payload.name);
    sheet.getRange(rowIndex, 3).setValue(payload.capacity);
    sheet.getRange(rowIndex, 4).setValue(payload.description);
    sheet.getRange(rowIndex, 5).setValue(payload.status);
    
    logActivity(ss, adminUser.email, adminUser.name, "EDIT_ROOM", "Name: " + oldName, "Name: " + payload.name + " (" + payload.status + ")", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "delete") {
    var rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === payload.id) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) throw new Error("Room not found");
    
    var roomName = data[rowIndex-1][1];
    
    if (hasPendingBookingsForRoomGS(ss, payload.id, roomName)) {
      throw new Error("ไม่สามารถลบห้องได้ เนื่องจากยังมีรอบไลฟ์ของห้องนี้รอค้างอยู่");
    }
    
    sheet.deleteRow(rowIndex);
    logActivity(ss, adminUser.email, adminUser.name, "DELETE_ROOM", "Room: " + roomName, "-", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
}

/**
 * Admin Panel Management: BRANDS
 */
function manageBrands(ss, adminUser, subAction, payload) {
  var sheet = ss.getSheetByName("Brands");
  var data = sheet.getDataRange().getValues();
  
  if (subAction === "list") {
    var brandsList = [];
    for (var i = 1; i < data.length; i++) {
      brandsList.push({
        id: data[i][0],
        name: data[i][1],
        status: data[i][2],
        owner: data[i][3] || ""
      });
    }
    return { brands: brandsList };
  }
  
  if (subAction === "add") {
    var newId = "BR_" + (data.length + 100);
    sheet.appendRow([newId, payload.name, "Active", payload.owner || ""]);
    logActivity(ss, adminUser.email, adminUser.name, "ADD_BRAND", "-", "Brand: " + payload.name, "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "edit") {
    var rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === payload.id) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) throw new Error("Brand not found");
    
    var oldName = data[rowIndex-1][1];
    var oldStatus = data[rowIndex-1][2];
    
    if (payload.status === "Inactive" && oldStatus !== "Inactive") {
      if (hasPendingBookingsForBrandGS(ss, oldName)) {
        throw new Error("ไม่สามารถปิดใช้งานแบรนด์นี้ได้ เนื่องจากยังมีคิวจองที่รอการไลฟ์ค้างอยู่");
      }
    }
    
    sheet.getRange(rowIndex, 2).setValue(payload.name);
    sheet.getRange(rowIndex, 3).setValue(payload.status);
    sheet.getRange(rowIndex, 4).setValue(payload.owner || "");
    
    logActivity(ss, adminUser.email, adminUser.name, "EDIT_BRAND", "Name: " + oldName, "Name: " + payload.name + " (" + payload.status + ")", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
  
  if (subAction === "delete") {
    var rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === payload.id) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) throw new Error("Brand not found");
    
    var brandName = data[rowIndex-1][1];
    if (hasPendingBookingsForBrandGS(ss, brandName)) {
      throw new Error("ไม่สามารถลบแบรนด์นี้ได้ เนื่องจากยังมีคิวจองที่รอการไลฟ์ค้างอยู่");
    }
    
    sheet.deleteRow(rowIndex);
    logActivity(ss, adminUser.email, adminUser.name, "DELETE_BRAND", "Brand: " + brandName, "-", "-", "-");
    SpreadsheetApp.flush();
    return { success: true };
  }
}

/**
 * Helper to log system activity
 */
function logActivity(ss, email, name, action, before, after, ip, device) {
  var sheet = ss.getSheetByName("ActivityLog");
  sheet.appendRow([
    new Date(),
    email,
    name,
    action,
    before || "-",
    after || "-",
    ip || "-",
    device || "-"
  ]);
}

/**
 * SHA-256 Hashing helper
 */
function hashSHA256(input) {
  var rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  var hexString = "";
  for (var i = 0; i < rawHash.length; i++) {
    var val = rawHash[i];
    if (val < 0) val += 256;
    var byteString = val.toString(16);
    if (byteString.length == 1) byteString = "0" + byteString;
    hexString += byteString;
  }
  return hexString;
}

/**
 * Get master password hash from Settings sheet or Cache
 */
function getMasterPasswordHash(ss) {
  var sheet = ss.getSheetByName("Settings");
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "MasterPasswordHash") {
      return data[i][1];
    }
  }
  // Setup default if missing
  var defaultHash = hashSHA256(MASTER_PASSWORD_DEFAULT);
  sheet.appendRow(["MasterPasswordHash", defaultHash]);
  return defaultHash;
}

/**
 * Set new master password hash
 */
function setMasterPasswordHash(ss, hashVal) {
  var sheet = ss.getSheetByName("Settings");
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "MasterPasswordHash") {
      sheet.getRange(i + 1, 2).setValue(hashVal);
      return;
    }
  }
  sheet.appendRow(["MasterPasswordHash", hashVal]);
}

/**
 * Automatically initialize all sheets and configurations
 */
function initSpreadsheet(ss) {
  if (!ss) {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  var sheetConfigs = {
    "Users": ["Email", "Name", "Role", "Status"],
    "Rooms": ["RoomID", "RoomName", "Capacity", "Description", "Status"],
    "Brands": ["BrandID", "BrandName", "Status", "Owner"],
    "Bookings": ["BookingID", "BrandName", "CampaignName", "RoomName", "Date", "StartTime", "EndTime", "Remark", "OwnerEmail", "OwnerName", "Status", "CreatedAt", "BriefText", "BriefLink", "LSArtworkLayout"],
    "ActivityLog": ["Timestamp", "UserEmail", "UserName", "Action", "Before", "After", "IP", "Device"],
    "Settings": ["Key", "Value"],
    "Roles": ["RoleName", "Description", "AllowedTabs", "CanCreateBooking", "CanEditBooking", "CanCancelBooking", "IsAdmin"]
  };
  
  for (var name in sheetConfigs) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(sheetConfigs[name]);
      sheet.getRange(1, 1, 1, sheetConfigs[name].length).setFontWeight("bold");
      
      // Seed default rooms for Rooms sheet if initializing for first time
      if (name === "Rooms") {
        for (var r = 1; r <= 21; r++) {
          var pad = (r < 10) ? "0" + r : r;
          sheet.appendRow(["RM_" + (100 + r), "Room " + pad, 5, "Studio Live Room " + pad, "Active"]);
        }
      }
      
      // Seed default brands if initializing for first time
      if (name === "Brands") {
        var defaultBrands = [
          "Foremost", "Royal Canin", "Club21", "Evony", "Subi", "Bostanten",
          "Glory", "Hi-Q", "Aristotle", "TandT", "Oceanglass", "Kemissara",
          "Babimild", "Fineline", "Fineline - AI", "Big C", "Dnee", "Neo Beauty",
          "Jabs-Beauty", "Jabs-Tissue", "Bio-Safety", "DNEE FB+SHP", "BetagroPet",
          "Bonny bliss", "BEO", "Yassia", "Taupe", "Ichitan", "Aldo", "WakingBee", "BabyLove"
        ];
        for (var b = 0; b < defaultBrands.length; b++) {
          sheet.appendRow(["BR_" + (101 + b), defaultBrands[b], "Active"]);
        }
      }

      // Seed default roles if initializing for first time
      if (name === "Roles") {
        var defaultRoles = [
          ["Master Admin", "แอดมินสิทธิ์สูงสุด", "my-bookings,calendar,scheduler,campaign-schedule,analytics,rooms,brands,users,audit-log,settings,roles-mgmt", "TRUE", "TRUE", "TRUE", "TRUE"],
          ["Admin", "ผู้ดูแลระบบ/ทีมงานตรวจสอบตาราง", "campaign-schedule", "FALSE", "FALSE", "FALSE", "FALSE"],
          ["Campaign Manager", "ผู้จัดการแคมเปญ/ทีมงานผู้จอง", "my-bookings,calendar,scheduler,campaign-schedule,analytics", "TRUE", "TRUE", "TRUE", "FALSE"],
          ["Viewer", "ผู้สังเกตการณ์/ผู้เข้าชม", "my-bookings,calendar,scheduler,campaign-schedule,analytics", "FALSE", "FALSE", "FALSE", "FALSE"]
        ];
        for (var i = 0; i < defaultRoles.length; i++) {
          sheet.appendRow(defaultRoles[i]);
        }
      }
    } else {
      // If sheet exists but is empty (just headers), seed default brands
      if (name === "Brands" && sheet.getLastRow() <= 1) {
        var defaultBrands = [
          "Foremost", "Royal Canin", "Club21", "Evony", "Subi", "Bostanten",
          "Glory", "Hi-Q", "Aristotle", "TandT", "Oceanglass", "Kemissara",
          "Babimild", "Fineline", "Fineline - AI", "Big C", "Dnee", "Neo Beauty",
          "Jabs-Beauty", "Jabs-Tissue", "Bio-Safety", "DNEE FB+SHP", "BetagroPet",
          "Bonny bliss", "BEO", "Yassia", "Taupe", "Ichitan", "Aldo", "WakingBee", "BabyLove"
        ];
        for (var b = 0; b < defaultBrands.length; b++) {
          sheet.appendRow(["BR_" + (101 + b), defaultBrands[b], "Active"]);
        }
      }

      // Seed default roles if sheet doesn't contain any roles
      if (name === "Roles") {
        var lastRow = sheet.getLastRow();
        var hasData = false;
        if (lastRow > 1) {
          var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
          for (var i = 0; i < values.length; i++) {
            if (values[i][0] && values[i][0].toString().trim() !== "") {
              hasData = true;
              break;
            }
          }
        }
        if (!hasData) {
          // Clear any garbage rows below headers
          if (lastRow > 1) {
            sheet.deleteRows(2, lastRow - 1);
          }
          var defaultRoles = [
            ["Master Admin", "แอดมินสิทธิ์สูงสุด", "my-bookings,calendar,scheduler,campaign-schedule,analytics,rooms,brands,users,audit-log,settings,roles-mgmt", "TRUE", "TRUE", "TRUE", "TRUE"],
            ["Admin", "ผู้ดูแลระบบ/ทีมงานตรวจสอบตาราง", "campaign-schedule", "FALSE", "FALSE", "FALSE", "FALSE"],
            ["Campaign Manager", "ผู้จัดการแคมเปญ/ทีมงานผู้จอง", "my-bookings,calendar,scheduler,campaign-schedule,analytics", "TRUE", "TRUE", "TRUE", "FALSE"],
            ["Viewer", "ผู้สังเกตการณ์/ผู้เข้าชม", "my-bookings,calendar,scheduler,campaign-schedule,analytics", "FALSE", "FALSE", "FALSE", "FALSE"]
          ];
          for (var i = 0; i < defaultRoles.length; i++) {
            sheet.appendRow(defaultRoles[i]);
          }
        }
      }
      
      // If sheet already exists, let's verify if all columns in config are present in the header row.
      // If not, we can update/extend the header row!
      var existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0];
      var targetHeaders = sheetConfigs[name];
      var needsUpdate = false;
      for (var j = 0; j < targetHeaders.length; j++) {
        if (existingHeaders.indexOf(targetHeaders[j]) === -1) {
          needsUpdate = true;
          break;
        }
      }
      if (needsUpdate) {
        // Rewrite headers to match the config, keeping existing data intact
        sheet.getRange(1, 1, 1, targetHeaders.length).setValues([targetHeaders]);
        sheet.getRange(1, 1, 1, targetHeaders.length).setFontWeight("bold");
      }
    }
  }
  
  // Set up auto clean time trigger programmatically
  setupAutoCleanTrigger();
}

/**
 * Automation Task: Daily Backup (1:00 AM)
 */
function runDailyBackup() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ssFile = DriveApp.getFileById(ss.getId());
    
    // Find or create backup folder
    var folders = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
    var backupFolder;
    if (folders.hasNext()) {
      backupFolder = folders.next();
    } else {
      backupFolder = DriveApp.createFolder(BACKUP_FOLDER_NAME);
    }
    
    // Create copy
    var timestamp = Utilities.formatDate(new Date(), getSpreadsheetTimeZoneCached(ss), "yyyy-MM-dd_HH-mm");
    var backupName = ss.getName() + "_Backup_" + timestamp;
    ssFile.makeCopy(backupName, backupFolder);
    
    // Cleanup copies older than 30 days
    var files = backupFolder.getFiles();
    var cutoff = new Date().getTime() - (30 * 24 * 60 * 60 * 1000); // 30 days
    while (files.hasNext()) {
      var file = files.next();
      if (file.getDateCreated().getTime() < cutoff) {
        file.setTrashed(true);
      }
    }
  } catch (error) {
    Logger.log("Backup failed: " + error.toString());
  }
}

/**
 * Automation Task: Yearly Archive (Dec 31st)
 */
function runYearlyArchive() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var bookingsSheet = ss.getSheetByName("Bookings");
    if (!bookingsSheet) return;
    
    var lastRow = bookingsSheet.getLastRow();
    if (lastRow <= 1) return; // Only headers
    
    var currentYear = new Date().getFullYear();
    var archiveSheetName = "Bookings_Archive_" + currentYear;
    
    // Create or find archive sheet
    var archiveSheet = ss.getSheetByName(archiveSheetName);
    if (!archiveSheet) {
      archiveSheet = ss.insertSheet(archiveSheetName);
      var headers = ["BookingID", "BrandName", "CampaignName", "RoomName", "Date", "StartTime", "EndTime", "Remark", "OwnerEmail", "OwnerName", "Status", "CreatedAt"];
      archiveSheet.appendRow(headers);
      archiveSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    }
    
    // Copy data
    var sourceRange = bookingsSheet.getRange(2, 1, lastRow - 1, 12);
    var destLastRow = archiveSheet.getLastRow();
    sourceRange.copyTo(archiveSheet.getRange(destLastRow + 1, 1));
    
    // Clear primary table (keeping header)
    bookingsSheet.deleteRows(2, lastRow - 1);
    
    // Log archiving event
    logActivity(ss, "SYSTEM", "Automated Year Archiver", "YEARLY_ARCHIVE", "-", "Archived " + (lastRow - 1) + " records to " + archiveSheetName, "-", "-");
  } catch (error) {
    Logger.log("Archive failed: " + error.toString());
  }
}

/**
 * Get or create a Google Drive folder inside a parent folder
 */
function getOrCreateFolder(parentFolder, folderName) {
  var folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(folderName);
}

/**
 * Automatically create Google Drive folders for a booking session:
 * TH Rooming -> [BrandName] -> [Month Year] -> [Date]_[Time]_[CampaignName]
 */
function createSessionDriveFolder(brandName, dateStr, startTime, campaignName) {
  try {
    var props = PropertiesService.getScriptProperties();
    
    // 1. Get or Create Root Folder "TH Rooming"
    var rootFolder;
    var rootFolderId = props.getProperty("ROOT_FOLDER_ID");
    if (rootFolderId) {
      try {
        rootFolder = DriveApp.getFolderById(rootFolderId);
      } catch(e) {}
    }
    if (!rootFolder) {
      var rootFolders = DriveApp.getFoldersByName("TH Rooming");
      if (rootFolders.hasNext()) {
        rootFolder = rootFolders.next();
      } else {
        rootFolder = DriveApp.createFolder("TH Rooming");
      }
      props.setProperty("ROOT_FOLDER_ID", rootFolder.getId());
    }
    
    // 2. Get or Create Brand Folder
    var brandCacheKey = "BRAND_FOLDER_ID_" + brandName.replace(/[^a-zA-Z0-9]/g, "_");
    var brandFolder;
    var brandFolderId = props.getProperty(brandCacheKey);
    if (brandFolderId) {
      try {
        brandFolder = DriveApp.getFolderById(brandFolderId);
      } catch(e) {}
    }
    if (!brandFolder) {
      brandFolder = getOrCreateFolder(rootFolder, brandName);
      props.setProperty(brandCacheKey, brandFolder.getId());
    }
    
    // 3. Parse Month-Year (e.g. "June 2026")
    var parts = dateStr.split("-"); // YYYY-MM-DD
    var year = parseInt(parts[0], 10);
    var monthIndex = parseInt(parts[1], 10) - 1;
    var day = parseInt(parts[2], 10);
    var dateObj = new Date(year, monthIndex, day);
    
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    var monthYearName = months[monthIndex] + " " + year;
    
    var monthCacheKey = "MONTH_FOLDER_ID_" + brandName.replace(/[^a-zA-Z0-9]/g, "_") + "_" + monthYearName.replace(/[^a-zA-Z0-9]/g, "_");
    var monthFolder;
    var monthFolderId = props.getProperty(monthCacheKey);
    if (monthFolderId) {
      try {
        monthFolder = DriveApp.getFolderById(monthFolderId);
      } catch(e) {}
    }
    if (!monthFolder) {
      monthFolder = getOrCreateFolder(brandFolder, monthYearName);
      props.setProperty(monthCacheKey, monthFolder.getId());
    }
    
    // 4. Create Session Folder
    var formattedDate = Utilities.formatDate(dateObj, getSpreadsheetTimeZoneCached(null), "dd-MM-yyyy");
    var sessionFolderName = formattedDate + "_" + startTime.replace(":", ".") + "_" + campaignName.replace(/[\\\/*?:"<>|]/g, "_"); // sanitize folder name
    var sessionFolder = monthFolder.createFolder(sessionFolderName);
    
    return sessionFolder.getUrl();
  } catch (e) {
    Logger.log("Error creating folder: " + e.toString());
    return ""; // Fallback
  }
}

/**
 * Auto clean folders older than 30 days
 */
function autoCleanOldFolders() {
  try {
    var rootFolders = DriveApp.getFoldersByName("TH Rooming");
    if (!rootFolders.hasNext()) return;
    var rootFolder = rootFolders.next();
    
    var brandFolders = rootFolder.getFolders();
    var now = new Date();
    var thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    while (brandFolders.hasNext()) {
      var brandFolder = brandFolders.next();
      var monthFolders = brandFolder.getFolders();
      
      while (monthFolders.hasNext()) {
        var monthFolder = monthFolders.next();
        var sessionFolders = monthFolder.getFolders();
        
        while (sessionFolders.hasNext()) {
          var sessionFolder = sessionFolders.next();
          // Check creation date of session folder
          if (sessionFolder.getDateCreated().getTime() < thirtyDaysAgo.getTime()) {
            Logger.log("Trashing old folder: " + sessionFolder.getName());
            sessionFolder.setTrashed(true); // Move to Drive Trash
          }
        }
        
        // Clean empty month folders
        if (!monthFolder.getFolders().hasNext() && !monthFolder.getFiles().hasNext()) {
          monthFolder.setTrashed(true);
        }
      }
      
      // Clean empty brand folders
      if (!brandFolder.getFolders().hasNext() && !brandFolder.getFiles().hasNext()) {
        brandFolder.setTrashed(true);
      }
    }
  } catch (e) {
    Logger.log("Auto-clean error: " + e.toString());
  }
}

/**
 * Setup Daily Time-Based Trigger programmatically
 */
function setupAutoCleanTrigger() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var triggerExists = false;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === "autoCleanOldFolders") {
        triggerExists = true;
        break;
      }
    }
    
    if (!triggerExists) {
      // Run every day between 2am and 3am
      ScriptApp.newTrigger("autoCleanOldFolders")
        .timeBased()
        .everyDays(1)
        .atHour(2)
        .create();
    }
  } catch (e) {
    Logger.log("Trigger setup failed: " + e.toString());
  }
}

/**
 * Get system settings for LINE OA notification
 */
function getSystemSettings(user) {
  var props = PropertiesService.getScriptProperties();
  return {
    lineChannelAccessToken: props.getProperty("LINE_CHANNEL_ACCESS_TOKEN") || "",
    lineDestinationId: props.getProperty("LINE_DESTINATION_ID") || "",
    lineNotificationsEnabled: props.getProperty("LINE_NOTIFICATIONS_ENABLED") === "true",
    frontendUrl: props.getProperty("FRONTEND_URL") || ""
  };
}

/**
 * Save system settings for LINE OA notification
 */
function saveSystemSettings(user, settings) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty("LINE_CHANNEL_ACCESS_TOKEN", settings.lineChannelAccessToken || "");
  props.setProperty("LINE_DESTINATION_ID", settings.lineDestinationId || "");
  props.setProperty("LINE_NOTIFICATIONS_ENABLED", settings.lineNotificationsEnabled ? "true" : "false");
  props.setProperty("FRONTEND_URL", settings.frontendUrl || "");
  return { success: true, message: "Settings saved successfully" };
}

/**
 * Helper to extract Google Drive Folder link from the lsArtworkLayout string
 */
function getGoogleDriveLink(lsArtworkLayoutStr) {
  if (!lsArtworkLayoutStr) return "";
  try {
    var list = JSON.parse(lsArtworkLayoutStr);
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].type === "Google Drive" && list[i].url) {
          return list[i].url;
        }
      }
    }
  } catch(e) {}
  if (typeof lsArtworkLayoutStr === "string" && lsArtworkLayoutStr.indexOf("http") === 0) {
    return lsArtworkLayoutStr;
  }
  return "";
}

/**
 * Send booking notification Flex message to LINE Destination ID
 */
function sendLineFlexMessage(booking, action) {
  var props = PropertiesService.getScriptProperties();
  var enabled = props.getProperty("LINE_NOTIFICATIONS_ENABLED") === "true";
  if (!enabled) return;
  
  var token = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  var destId = props.getProperty("LINE_DESTINATION_ID");
  if (!token || !destId) return;

  var dateStr = booking.date;
  try {
    var d = new Date(booking.date);
    var months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    var year = d.getFullYear() + 543;
    dateStr = d.getDate() + " " + months[d.getMonth()] + " " + year;
  } catch(e) {}

  var title = "";
  var headerColor = "";
  
  if (action === "CREATE") {
    title = "✨ จองห้องสตูดิโอใหม่สำเร็จ";
    headerColor = "#06C755";
  } else if (action === "UPDATE") {
    title = "✏️ แก้ไขข้อมูลการจองห้อง";
    headerColor = "#EAA800";
  } else if (action === "CANCEL") {
    title = "❌ ยกเลิกการจองห้องสตูดิโอ";
    headerColor = "#D9383A";
  }

  var driveLink = getGoogleDriveLink(booking.lsArtworkLayout);
  
  var flexBubble = {
    "type": "bubble",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": title,
          "weight": "bold",
          "size": "lg",
          "color": "#FFFFFF"
        }
      ],
      "backgroundColor": headerColor,
      "paddingAll": "md"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "รายละเอียดคิวงาน",
          "weight": "bold",
          "size": "sm",
          "color": "#111111",
          "margin": "md"
        },
        {
          "type": "separator",
          "margin": "xs"
        },
        {
          "type": "box",
          "layout": "vertical",
          "margin": "md",
          "spacing": "sm",
          "contents": [
            {
              "type": "box",
              "layout": "baseline",
              "spacing": "sm",
              "contents": [
                {
                  "type": "text",
                  "text": "ห้อง",
                  "color": "#aaaaaa",
                  "size": "xs",
                  "flex": 2
                },
                {
                  "type": "text",
                  "text": booking.roomName || "-",
                  "wrap": true,
                  "color": "#333333",
                  "size": "xs",
                  "flex": 8,
                  "weight": "bold"
                }
              ]
            },
            {
              "type": "box",
              "layout": "baseline",
              "spacing": "sm",
              "contents": [
                {
                  "type": "text",
                  "text": "แบรนด์",
                  "color": "#aaaaaa",
                  "size": "xs",
                  "flex": 2
                },
                {
                  "type": "text",
                  "text": booking.brandName || "-",
                  "wrap": true,
                  "color": "#333333",
                  "size": "xs",
                  "flex": 8
                }
              ]
            },
            {
              "type": "box",
              "layout": "baseline",
              "spacing": "sm",
              "contents": [
                {
                  "type": "text",
                  "text": "แคมเปญ",
                  "color": "#aaaaaa",
                  "size": "xs",
                  "flex": 2
                },
                {
                  "type": "text",
                  "text": booking.campaignName || "-",
                  "wrap": true,
                  "color": "#333333",
                  "size": "xs",
                  "flex": 8
                }
              ]
            },
            {
              "type": "box",
              "layout": "baseline",
              "spacing": "sm",
              "contents": [
                {
                  "type": "text",
                  "text": "วันจอง",
                  "color": "#aaaaaa",
                  "size": "xs",
                  "flex": 2
                },
                {
                  "type": "text",
                  "text": dateStr,
                  "wrap": true,
                  "color": "#333333",
                  "size": "xs",
                  "flex": 8
                }
              ]
            },
            {
              "type": "box",
              "layout": "baseline",
              "spacing": "sm",
              "contents": [
                {
                  "type": "text",
                  "text": "เวลา",
                  "color": "#aaaaaa",
                  "size": "xs",
                  "flex": 2
                },
                {
                  "type": "text",
                  "text": (booking.startTime || "-") + " - " + (booking.endTime || "-") + " น.",
                  "wrap": true,
                  "color": "#333333",
                  "size": "xs",
                  "flex": 8,
                  "weight": "bold"
                }
              ]
            },
            {
              "type": "box",
              "layout": "baseline",
              "spacing": "sm",
              "contents": [
                {
                  "type": "text",
                  "text": "ผู้จอง",
                  "color": "#aaaaaa",
                  "size": "xs",
                  "flex": 2
                },
                {
                  "type": "text",
                  "text": booking.ownerName || "-",
                  "wrap": true,
                  "color": "#333333",
                  "size": "xs",
                  "flex": 8
                }
              ]
            }
          ]
        }
      ]
    }
  };

  if (booking.remark) {
    flexBubble.body.contents[2].contents.push({
      "type": "box",
      "layout": "baseline",
      "spacing": "sm",
      "contents": [
        {
          "type": "text",
          "text": "หมายเหตุ",
          "color": "#aaaaaa",
          "size": "xs",
          "flex": 2
        },
        {
          "type": "text",
          "text": booking.remark,
          "wrap": true,
          "color": "#666666",
          "size": "xs",
          "flex": 8
        }
      ]
    });
  }

  var footerContents = [];
  
  if (driveLink) {
    footerContents.push({
      "type": "button",
      "style": "primary",
      "color": "#06C755",
      "height": "sm",
      "action": {
        "type": "uri",
        "label": "📁 เปิดโฟลเดอร์ Google Drive",
        "uri": driveLink
      },
      "margin": "xs"
    });
  }
  
  if (booking.briefLink) {
    footerContents.push({
      "type": "button",
      "style": "secondary",
      "height": "sm",
      "action": {
        "type": "uri",
        "label": "📄 ดูไฟล์แนบ Brief / Script",
        "uri": booking.briefLink
      },
      "margin": "xs"
    });
  }

  var webAppUrl = props.getProperty("FRONTEND_URL") || "";
  if (!webAppUrl) {
    try {
      webAppUrl = ScriptApp.getService().getUrl();
    } catch(e) {}
  }
  
  if (webAppUrl) {
    footerContents.push({
      "type": "button",
      "style": "link",
      "height": "sm",
      "action": {
        "type": "uri",
        "label": "🌐 เข้าสู่ระบบจองห้องสตูดิโอ",
        "uri": webAppUrl
      },
      "margin": "xs"
    });
  }

  if (footerContents.length > 0) {
    flexBubble.footer = {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": footerContents
    };
  }

  var payload = {
    "to": destId,
    "messages": [
      {
        "type": "flex",
        "altText": title + ": " + (booking.brandName || "") + " (" + (booking.roomName || "") + ")",
        "contents": flexBubble
      }
    ]
  };

  try {
    var response = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      "method": "post",
      "headers": {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    });
    Logger.log("LINE push response: " + response.getContentText());
  } catch(e) {
    Logger.log("Failed to send LINE push: " + e.message);
  }
}

/**
 * Handle incoming LINE Webhook events (e.g. "ขอไอดีกลุ่ม")
 */
function handleLineWebhook(payload) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) return ContentService.createTextOutput("OK");
  
  var events = payload.events;
  if (!events || events.length === 0) {
    return ContentService.createTextOutput("OK");
  }
  
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (event.type === "message" && event.message && event.message.type === "text") {
      var userText = event.message.text.trim();
      if (userText === "ขอไอดีกลุ่ม" || userText === "ขอไอดี" || userText === "get id" || userText === "Get id") {
        var replyToken = event.replyToken;
        var source = event.source || {};
        var replyText = "";
        
        if (source.type === "group") {
          replyText = "Group ID ของกลุ่มนี้คือ:\n" + source.groupId;
        } else if (source.type === "room") {
          replyText = "Room ID ของห้องนี้คือ:\n" + source.roomId;
        } else {
          replyText = "User ID ของคุณคือ:\n" + source.userId;
        }
        
        sendLineReply(replyToken, replyText, token);
      }
    } else if (event.type === "join") {
      var replyToken = event.replyToken;
      var source = event.source || {};
      var replyText = "สวัสดีครับผมเป็นบอทจองห้องสตูดิโอ\n";
      if (source.type === "group") {
        replyText += "Group ID ของกลุ่มนี้คือ:\n" + source.groupId;
      } else if (source.type === "room") {
        replyText += "Room ID ของห้องนี้คือ:\n" + source.roomId;
      }
      sendLineReply(replyToken, replyText, token);
    }
  }
  
  return ContentService.createTextOutput("OK");
}

/**
 * Helper to reply to LINE messages using replyToken
 */
function sendLineReply(replyToken, text, token) {
  var payload = {
    "replyToken": replyToken,
    "messages": [
      {
        "type": "text",
        "text": text
      }
    ]
  };
  
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      "method": "post",
      "headers": {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    });
  } catch(e) {
    Logger.log("Failed to send LINE reply: " + e.message);
  }
}



/**
 * Log in user by validating email and password
 */
function loginUser(ss, email, password) {
  if (!email || !password) {
    throw new Error("กรุณากรอกชื่อผู้ใช้และรหัสผ่าน");
  }
  
  // Auto-initialize if empty or missing admin
  seedDefaultAdminIfNeeded(ss);
  
  var user = getUserRecord(ss, email);
  if (!user) {
    throw new Error("ไม่พบบัญชีผู้ใช้งานนี้ในระบบ. กรุณาตรวจสอบชื่อผู้ใช้งานในแผ่นงาน Users บน Google Sheets");
  }
  
  if (user.status !== "Active") {
    throw new Error("บัญชีผู้ใช้งานนี้ถูกระงับการใช้งาน");
  }
  
  var dbPassword = user.password;
  if (dbPassword === "") {
    dbPassword = "Admin@1234"; // Default password fallback for pre-existing users
    setUserPasswordInSheet(ss, email, dbPassword);
  }
  
  if (dbPassword !== password) {
    throw new Error("รหัสผ่านไม่ถูกต้อง");
  }
  
  // Generate custom token: email + ":" + hashSHA256(email + getMasterPasswordHash(ss))
  var sessionToken = email + ":" + hashSHA256(email + getMasterPasswordHash(ss));
  
  return {
    success: true,
    token: sessionToken,
    user: {
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status
    }
  };
}

/**
 * Save user password in Google Sheets database
 */
function setUserPasswordInSheet(ss, email, password) {
  var sheet = ss.getSheetByName("Users");
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().toLowerCase().trim() === email.toLowerCase().trim()) {
      if (sheet.getLastColumn() < 5) {
        sheet.getRange(1, 5).setValue("Password").setFontWeight("bold");
      }
      sheet.getRange(i + 1, 5).setValue(password);
      break;
    }
  }
}

/**
 * Verify custom session token
 */
function verifyCustomToken(ss, token) {
  if (!token) return null;
  var parts = token.split(":");
  if (parts.length !== 2) return null;
  var email = parts[0];
  var hash = parts[1];
  
  var expectedHash = hashSHA256(email + getMasterPasswordHash(ss));
  if (hash === expectedHash) {
    return email;
  }
  return null;
}

/**
 * Seed default Master Admin user if Users sheet has no Master Admin
 */
function seedDefaultAdminIfNeeded(ss) {
  var sheet = ss.getSheetByName("Users");
  if (!sheet) return;
  
  var data = sheet.getDataRange().getValues();
  var hasAdmin = false;
  for (var i = 1; i < data.length; i++) {
    if (data[i][2] === "Master Admin") {
      hasAdmin = true;
      break;
    }
  }
  
  if (sheet.getLastRow() <= 1 || !hasAdmin) {
    if (sheet.getLastColumn() < 5) {
      sheet.getRange(1, 5).setValue("Password").setFontWeight("bold");
    }
    sheet.appendRow(["admin", "System Admin", "Master Admin", "Active", "Admin@1234"]);
  }
}
