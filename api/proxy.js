const https = require('https');

module.exports = function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  const gasUrl = "https://script.google.com/macros/s/AKfycbyUm0c2LCXIS9b76TsTmD7mWVzAuILkGa4HJUbHfoUDBBRflfVXAV26TBSgUYAFoqtX/exec";

  // Forward the request body to GAS
  let payload = "";
  if (typeof req.body === 'string') {
    payload = req.body;
  } else if (req.body && typeof req.body === 'object') {
    payload = JSON.stringify(req.body);
  } else {
    payload = "{}";
  }

  const gasReq = https.request(gasUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (gasRes) => {
    // Follow redirect
    if (gasRes.statusCode === 302 && gasRes.headers.location) {
      https.get(gasRes.headers.location, (redirectRes) => {
        let body = '';
        redirectRes.on('data', chunk => body += chunk);
        redirectRes.on('end', () => {
          res.setHeader('Content-Type', 'application/json;charset=utf-8');
          res.status(redirectRes.statusCode).send(body);
        });
      }).on('error', (err) => {
        res.status(500).json({ success: false, message: 'Redirect error: ' + err.message });
      });
    } else {
      let body = '';
      gasRes.on('data', chunk => body += chunk);
      gasRes.on('end', () => {
        res.setHeader('Content-Type', 'application/json;charset=utf-8');
        res.status(gasRes.statusCode).send(body);
      });
    }
  });

  gasReq.on('error', (err) => {
    res.status(500).json({ success: false, message: 'Request error: ' + err.message });
  });

  gasReq.write(payload);
  gasReq.end();
};
