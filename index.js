const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const markdown = require('markdown-it')();
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const { webcrypto } = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Parse JSON bodies and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set up session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Anti-spam protection for form submission
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: 'Too many booking attempts, please try again later.'
});

// Add this to store captchas (in a real application, you might want to use a database)
const captchas = new Map();

// Add this function to generate a captcha
function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const sum = num1 + num2;
  const idArray = new Uint8Array(16);
  webcrypto.getRandomValues(idArray);
  const id = Array.from(idArray, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    id,
    question: `What is ${num1} + ${num2}?`,
    answer: sum,
    createdAt: Date.now()
  };
}

function cleanupCaptchas() {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [id, captcha] of captchas.entries()) {
    if (captcha.createdAt < fiveMinutesAgo) {
      captchas.delete(id);
    }
  }
}

// Call this function periodically, e.g., every 5 minutes
setInterval(cleanupCaptchas, 5 * 60 * 1000);

// Function to hash password
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const key = await webcrypto.subtle.importKey('raw', data, 'PBKDF2', false, ['deriveBits']);
    const derivedBits = await webcrypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        key,
        256
    );
    const hashArray = Array.from(new Uint8Array(derivedBits));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${Buffer.from(salt).toString('hex')}:${hashHex}`;
}

// Function to verify password
async function verifyPassword(storedPassword, inputPassword) {
    const [saltHex, storedHash] = storedPassword.split(':');
    const salt = Uint8Array.from(Buffer.from(saltHex, 'hex'));
    const encoder = new TextEncoder();
    const data = encoder.encode(inputPassword);
    const key = await webcrypto.subtle.importKey('raw', data, 'PBKDF2', false, ['deriveBits']);
    const derivedBits = await webcrypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        key,
        256
    );
    const hashArray = Array.from(new Uint8Array(derivedBits));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return storedHash === hashHex;
}

async function initializeBookingsFile() {
  const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
  try {
    await fs.access(bookingsPath);
  } catch (error) {
    await fs.writeFile(bookingsPath, '[]');
    console.log('Created empty bookings.json file');
  }
}

async function getServices() {
  const servicesDir = path.join(__dirname, 'content', 'services');
  try {
    const files = await fs.readdir(servicesDir);
    const services = [];

    for (const file of files) {
      if (path.extname(file).toLowerCase() === '.md') {
        const filePath = path.join(servicesDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const service = parseServiceMarkdown(content);
        services.push(service);
      }
    }

    // console.log('Parsed services:', services);
    return services;
  } catch (error) {
    // console.error('Error reading services:', error);
    return [];
  }
}

// Add this new function to generate a short ID
function generateShortId() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded I, O, 0, 1 for clarity
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Parse the Service from Markdown

function parseServiceMarkdown(content) {
  const lines = content.split('\n');
  const service = {
    title: '',
    description: '',
    price: 0,
    thumbnail: '',
    category: '',
    addons: [],
    options: []
  };

  let currentSection = '';

  lines.forEach((line, index) => {
    line = line.trim();
    if (line.startsWith('# ')) {
      service.title = line.slice(2);
    } else if (index === 1) {
      service.description = line;
    } else if (line.startsWith('## ') && line.toLowerCase().includes('price')) {
      const priceMatch = line.match(/\$(\d+(\.\d{1,2})?)/);
      if (priceMatch) {
        service.price = parseFloat(priceMatch[1]);
      }
    } else if (line.startsWith('Thumbnail: ')) {
      service.thumbnail = line.slice(11);
    } else if (line.startsWith('Category: ')) {
      service.category = line.slice(10);
    } else if (line === '### Addons:') {
      currentSection = 'addons';
    } else if (line === '### Options:') {
      currentSection = 'options';
    } else if (currentSection === 'addons' && line.startsWith('- ')) {
      const [name, priceStr] = line.slice(2).split(': $');
      const description = lines[index + 1].trim().slice(12);
      service.addons.push({
        name,
        price: parseFloat(priceStr),
        description
      });
    } else if (currentSection === 'options' && line.startsWith('- ')) {
      const match = line.match(/- \[(.*?)\] (.*?)( \(required\))?: (.*)/);
      if (match) {
        const values = match[4].split(', ').map(v => {
          const priceMatch = v.match(/(.*?) \(\+?\$([\d.]+)\)/);
          return priceMatch 
            ? { name: priceMatch[1], price: parseFloat(priceMatch[2]) }
            : { name: v, price: 0 };
        });
        service.options.push({
          type: match[1],
          name: match[2],
          required: !!match[3],
          values: values
        });
      }
    }
  });

  return service;
}

async function getSettings() {
  const settingsPath = path.join(__dirname, 'content', 'settings.json');
  const settingsData = await fs.readFile(settingsPath, 'utf-8');
  return JSON.parse(settingsData);
}

async function updateSettings(newSettings) {
  const settingsPath = path.join(__dirname, 'content', 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));
}

// Route to set or update password
app.get('/set-password', async (req, res) => {
  const newPassword = req.query.password;

  if (!newPassword || newPassword.length < 8) {
      return res.status(400).send('Password must be at least 8 characters long');
  }

  try {
      const hashedPassword = await hashPassword(newPassword);
      
      const settings = await getSettings();
      settings.reportPassword = hashedPassword;
      await updateSettings(settings);
      
      res.send(`New password has been set and saved to settings.json`);
  } catch (error) {
      console.error('Error setting new password:', error);
      res.status(500).send('An error occurred while setting the new password');
  }
});

app.get('/', async (req, res) => {
  try {
    const services = await getServices();
    // console.log('Services to be rendered:', services);
    res.render('index', { services });
  } catch (error) {
    console.error('Error in root route:', error);
    res.status(500).render('error', { 
      message: 'An error occurred while loading services',
      error: error
    });
  }
});

app.get('/booking-form', async (req, res) => {
  try {
    const services = await getServices();
    const service = services.find(s => s.title === req.query.service);
    if (service) {
      const settings = await getSettings();
      const captcha = generateCaptcha();
      captchas.set(captcha.id, captcha);  // Store the entire captcha object
      res.render('booking-form', { 
        service, 
        whatsappNumber: settings.whatsapp_number,
        captcha: { id: captcha.id, question: captcha.question }
      });
    } else {
      res.status(404).render('error', { 
        message: 'Service not found',
        error: null
      });
    }
  } catch (error) {
    console.error('Error in booking form route:', error);
    res.status(500).render('error', { 
      message: 'An error occurred while loading the booking form',
      error: error
    });
  }
});

app.post('/submit-booking', submitLimiter, async (req, res) => {
  try {
    const { service, date, addons, options, name, whatsappNumber, email, captcha, captchaId } = req.body;

    // Verify captcha
    const captchaObj = captchas.get(captchaId);
    captchas.delete(captchaId); // Remove used captcha

    if (!captchaObj || parseInt(captcha) !== captchaObj.answer) {
      return res.status(400).render('error', {
        message: 'Invalid captcha. Please try again.',
        error: null
      });
    }

    const services = await getServices();
    const selectedService = services.find(s => s.title === service);
    
    if (!selectedService) {
      return res.status(400).send('Invalid service selected');
    }

    let totalPrice = selectedService.price;
    const selectedAddons = Array.isArray(addons) ? addons : [addons].filter(Boolean);
    const addonDetails = selectedAddons.map(addon => {
      const addonInfo = selectedService.addons.find(a => a.name === addon);
      totalPrice += addonInfo.price;
      return `${addonInfo.name}: $${addonInfo.price}`;
    });

    // Calculate price from options
    Object.entries(options).forEach(([optionName, selectedValue]) => {
      const option = selectedService.options.find(o => o.name === optionName);
      if (option) {
        const selectedOptionValue = option.values.find(v => v.name === selectedValue);
        if (selectedOptionValue) {
          totalPrice += selectedOptionValue.price;
        }
      }
    });

    // Generate a unique short ID
    let shortId;
    let isUnique = false;
    const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
    const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
    const bookings = JSON.parse(bookingsData);

    while (!isUnique) {
      shortId = generateShortId();
      isUnique = !bookings.some(booking => booking.id === shortId);
    }

    const booking = {
      id: shortId,
      name,
      whatsappNumber,
      email,
      serviceTitle: service,
      date,
      addons: selectedAddons.map(addon => {
        const addonInfo = selectedService.addons.find(a => a.name === addon);
        return { name: addon, price: addonInfo.price };
      }),
      options,
      totalPrice,
      status: 'pending'
    };

    // Save booking to JSON file
    bookings.push(booking);
    await fs.writeFile(bookingsPath, JSON.stringify(bookings, null, 2));

    // Prepare WhatsApp message
    const settings = await getSettings();
    const whatsappMessage = encodeURIComponent(`Hello! I'd like to confirm my booking:\n\nBooking ID: ${booking.id}\nService: ${booking.serviceTitle}\nDate: ${booking.date}\nTotal Price: $${booking.totalPrice}\n\nThank you!`);
    const whatsappUrl = `https://wa.me/${settings.whatsapp_number}?text=${whatsappMessage}`;

    // Redirect to a success page instead of rendering
    res.redirect(`/booking-success?id=${booking.id}&whatsapp=${encodeURIComponent(whatsappUrl)}`);
  } catch (error) {
    console.error('Error submitting booking:', error);
    res.status(500).render('error', { 
      message: 'An error occurred while submitting the booking',
      error: error
    });
  }
});

app.get('/booking-success', (req, res) => {
  const { id, whatsapp } = req.query;
  
  if (!id) {
    return res.redirect('/');  // Redirect to home if no booking ID is provided
  }

  res.render('booking-success', { bookingId: id, whatsappUrl: whatsapp });
});

app.get('/booking-report', async (req, res) => {
  if (req.session.isAuthenticated) {
    try {
      await initializeBookingsFile();
      const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
      const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
      const bookings = JSON.parse(bookingsData);
      res.render('booking-report', { bookings });
    } catch (error) {
      console.error('Error in booking report route:', error);
      res.status(500).render('error', { 
        message: 'An error occurred while loading the booking report',
        error: error
      });
    }
  } else {
    res.render('login');
  }
});

app.post('/login', async (req, res) => {
  const { password } = req.body;
  const settings = await getSettings();
  
  try {
    if (await verifyPassword(settings.reportPassword, password)) {
      req.session.isAuthenticated = true;
      res.redirect('/booking-report');
    } else {
      res.render('login', { error: 'Invalid password' });
    }
  } catch (error) {
    console.error('Error verifying password:', error);
    res.status(500).send('An error occurred while verifying the password');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    res.redirect('/');
  });
});

app.get('/track-booking', (req, res) => {
  res.render('track-booking');
});

app.post('/track-booking', async (req, res) => {
  const { bookingId } = req.body;
  const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
  const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
  const bookings = JSON.parse(bookingsData);
  
  const booking = bookings.find(b => b.id === bookingId);
  
  if (booking) {
    res.render('booking-details', { booking });
  } else {
    res.render('track-booking', { error: 'Booking not found' });
  }
});

app.post('/update-booking-status', async (req, res) => {
  try {
    const { id, status } = req.body;
    const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
    const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
    let bookings = JSON.parse(bookingsData);
    
    const booking = bookings.find(b => b.id === id);
    if (booking) {
      booking.status = status;
      await fs.writeFile(bookingsPath, JSON.stringify(bookings, null, 2));
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: 'Booking not found' });
    }
  } catch (error) {
    console.error('Error updating booking status:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the booking status' });
  }
});

app.post('/delete-booking', async (req, res) => {
  try {
    const { id } = req.body;
    const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
    const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
    let bookings = JSON.parse(bookingsData);
    
    const updatedBookings = bookings.filter(b => b.id !== id);
    if (bookings.length !== updatedBookings.length) {
      await fs.writeFile(bookingsPath, JSON.stringify(updatedBookings, null, 2));
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: 'Booking not found' });
    }
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the booking' });
  }
});

app.get('/get-settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ whatsapp_number: settings.whatsapp_number });
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({ error: 'An error occurred while fetching settings' });
  }
});

// Add a catch-all route for 404 errors
app.use((req, res) => {
  res.status(404).render('error', { 
    message: 'Page not found',
    error: null
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { 
    message: 'Something broke!',
    error: err
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});