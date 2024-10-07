const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const markdown = require('markdown-it')();
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const { webcrypto } = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

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

// Add this middleware after your session middleware
app.use((req, res, next) => {
  res.locals.isAuthenticated = req.session.isAuthenticated || false;
  next();
});

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

// Set up multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // Limit file size to 5MB
  },
});

async function deleteFileIfExists(filePath) {
  try {
    await fs.access(filePath);
    await fs.unlink(filePath);
    console.log(`Deleted file: ${filePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Error deleting file ${filePath}:`, error);
    }
  }
}

// Ensure necessary directories exist
async function ensureDirectoriesExist() {
  const dirs = [
    path.join(__dirname, 'uploads'),
    path.join(__dirname, 'public', 'images', 'comments')
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Call this function before setting up your routes
ensureDirectoriesExist().then(() => {
  // Your existing app setup and routes go here
}).catch(err => {
  console.error('Error creating directories:', err);
  process.exit(1);
});

// Helper function to generate a unique filename
function generateUniqueFilename(originalname) {
  const date = new Date();
  const timestamp = date.toISOString().replace(/[-:.]/g, "");
  const random = Math.random().toString(36).substring(2, 15);
  const extension = path.extname(originalname);
  return `${timestamp}-${random}${extension}`;
}

// Helper function to save compressed image
async function saveCompressedImage(file) {
  const filename = generateUniqueFilename(file.originalname);
  const outputDir = path.join(__dirname, 'public', 'images', 'comments');
  const fullSizePath = path.join(outputDir, `full_${filename}`);
  const thumbnailPath = path.join(outputDir, `thumb_${filename}`);

  try {
    await fs.mkdir(outputDir, { recursive: true });

    // Save full-size image
    await sharp(file.buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(fullSizePath);

    // Save thumbnail
    await sharp(file.buffer)
      .resize(50, 50, { fit: 'cover' })
      .jpeg({ quality: 70 })
      .toFile(thumbnailPath);

    // Try to delete the temporary file, but don't throw an error if it fails
    try {
      await fs.unlink(file.path);
    } catch (unlinkError) {
      console.warn('Warning: Could not delete temporary file:', unlinkError.message);
    }

    return {
      fullSize: `/images/comments/full_${filename}`,
      thumbnail: `/images/comments/thumb_${filename}`
    };
  } catch (error) {
    console.error('Error saving compressed image:', error);
    throw error;
  }
}

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

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { password } = req.body;
  const settings = await getSettings();
  
  try {
    if (await verifyPassword(settings.reportPassword, password)) {
      req.session.isAuthenticated = true;
      // Redirect to the page they were trying to access, or to home if no specific page
      const redirectTo = req.session.returnTo || '/';
      delete req.session.returnTo;
      res.redirect(redirectTo);
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
    if (err) {
      console.error('Error destroying session:', err);
    }
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
    // Set the trackingBookingId in the session
    req.session.trackingBookingId = bookingId;
    // Redirect to the booking details page
    res.redirect(`/booking-details/${bookingId}`);
  } else {
    res.render('track-booking', { error: 'Booking not found' });
  }
});

// Route to view booking details
app.get('/booking-details/:id', async (req, res) => {
  try {
    const bookingId = req.params.id;

    // Fetch booking data
    const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
    const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
    const bookings = JSON.parse(bookingsData);
    const booking = bookings.find(b => b.id === bookingId);

    if (!booking) {
      return res.status(404).render('error', { message: 'Booking not found' });
    }

    // Fetch comments
    let comments = [];
    const commentsPath = path.join(__dirname, 'data', 'comments.json');
    try {
      const commentsData = await fs.readFile(commentsPath, 'utf-8');
      comments = JSON.parse(commentsData).filter(c => c.bookingId === bookingId);
    } catch (error) {
      console.error('Error reading comments:', error);
      // If there's an error reading comments, we'll just use an empty array
    }

    // Check if the user is authenticated or is tracking this booking
    const isAuthenticated = req.session.isAuthenticated || false;
    const isTrackingClient = req.session.trackingBookingId === bookingId;
    const canViewBooking = isAuthenticated || isTrackingClient;

    if (!canViewBooking) {
      return res.status(403).render('error', { message: 'You do not have permission to view this booking' });
    }

    // Render the booking details page
    res.render('booking-details', { 
      booking, 
      comments, 
      isAuthenticated,
      canComment: true, // Allow both authenticated users and tracking clients to comment
      canDelete: isAuthenticated // Only authenticated users can delete comments
    });

  } catch (error) {
    console.error('Error in booking details route:', error);
    res.status(500).render('error', { 
      message: 'An error occurred while loading the booking details',
      error: error
    });
  }
});

// Route to add a comment
app.post('/booking-details/:id/comment', upload.single('image'), async (req, res) => {
  const bookingId = req.params.id;
  const { content } = req.body;
  const isAdmin = req.session.isAuthenticated;
  const isTrackingClient = req.session.trackingBookingId === bookingId;

  if (!isAdmin && !isTrackingClient) {
    return res.status(403).render('error', { message: 'You do not have permission to post comments' });
  }
  
  let imagePaths = null;
  if (req.file) {
    imagePaths = await saveCompressedImage(req.file);
  }
  
  const comment = {
    id: Date.now().toString(),
    bookingId,
    content,
    imagePaths,
    createdAt: new Date().toISOString(),
    isAdmin
  };
  
  const commentsPath = path.join(__dirname, 'data', 'comments.json');
  const commentsData = await fs.readFile(commentsPath, 'utf-8');
  const comments = JSON.parse(commentsData);
  comments.push(comment);
  await fs.writeFile(commentsPath, JSON.stringify(comments, null, 2));
  
  res.redirect(`/booking-details/${bookingId}`);
});

// Route to delete a comment (admin only)
app.post('/booking-details/:bookingId/comment/:commentId/delete', async (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.status(403).send('Unauthorized');
  }
  const { bookingId, commentId } = req.params;
  
  const commentsPath = path.join(__dirname, 'data', 'comments.json');
  const commentsData = await fs.readFile(commentsPath, 'utf-8');
  let comments = JSON.parse(commentsData);
  
  // Find the comment to be deleted
  const commentToDelete = comments.find(c => c.id === commentId);
  
  if (commentToDelete && commentToDelete.imagePaths) {
    // Delete the full-size image
    const fullSizePath = path.join(__dirname, 'public', commentToDelete.imagePaths.fullSize);
    await deleteFileIfExists(fullSizePath);
    
    // Delete the thumbnail
    const thumbnailPath = path.join(__dirname, 'public', commentToDelete.imagePaths.thumbnail);
    await deleteFileIfExists(thumbnailPath);
  }
  
  // Remove the comment from the array
  comments = comments.filter(c => c.id !== commentId);
  
  // Save the updated comments array
  await fs.writeFile(commentsPath, JSON.stringify(comments, null, 2));
  
  res.redirect(`/booking-details/${bookingId}`);
});

// Update the booking-report route to include links to booking details
// Booking report route
app.get('/booking-report', async (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.redirect('/login');
  }
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

// Route to list all service files
app.get('/service-editor', async (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.redirect('/login');
  }
  const servicesDir = path.join(__dirname, 'content', 'services');
  const files = await fs.readdir(servicesDir);
  res.render('service-editor-list', { files });
});

// Route to edit a specific service file
app.get('/service-editor/:filename', async (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.redirect('/login');
  }
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'content', 'services', filename);
  const content = await fs.readFile(filePath, 'utf-8');
  res.render('service-editor', { filename, content });
});

// Route to save changes to a service file
app.post('/service-editor/:filename', async (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.status(403).send('Unauthorized');
  }
  const filename = req.params.filename;
  const content = req.body.content;
  const filePath = path.join(__dirname, 'content', 'services', filename);
  await fs.writeFile(filePath, content);
  res.redirect('/service-editor');
});

// Route to create a new service file
app.post('/service-editor', async (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.status(403).send('Unauthorized');
  }
  const filename = req.body.filename;
  const filePath = path.join(__dirname, 'content', 'services', filename);
  await fs.writeFile(filePath, '# New Service\nDescription goes here.\n\n## Price: $0\n\nThumbnail: /path/to/image.jpg\nCategory: New Category');
  res.redirect(`/service-editor/${filename}`);
});

// Route to delete a service file
app.delete('/service-editor/:filename', async (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.status(403).send('Unauthorized');
  }
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'content', 'services', filename);
  await fs.unlink(filePath);
  res.sendStatus(200);
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