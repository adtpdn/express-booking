const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const markdown = require('markdown-it')();
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

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
      if (path.extname(file) === '.md') {
        const content = await fs.readFile(path.join(servicesDir, file), 'utf-8');
        const service = parseServiceMarkdown(content);
        services.push(service);
      }
    }

    return services;
  } catch (error) {
    console.error('Error reading services:', error);
    return []; // Return an empty array if there's an error
  }
}

function parseServiceMarkdown(content) {
  const html = markdown.render(content);
  const lines = html.split('\n');
  const service = {
    title: 'Default Title',
    description: 'Default Description',
    price: 100,
    thumbnail: '/images/default.jpg',
    addons: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('<h1>') && line.endsWith('</h1>')) {
      service.title = line.slice(4, -5);
    } else if (i === 1 && !line.startsWith('<')) {
      service.description = line;
    } else if (line.startsWith('<h2>Price: $') && line.endsWith('</h2>')) {
      service.price = parseFloat(line.slice(12, -5));
    } else if (line.startsWith('<p>Thumbnail: ') && line.endsWith('</p>')) {
      service.thumbnail = line.slice(13, -4);
    } else if (line.startsWith('<li>') && line.endsWith('</li>')) {
      const addonStr = line.slice(4, -5);
      const [name, price] = addonStr.split(': $');
      service.addons.push({ name, price: parseFloat(price) });
    }
  }

  return service;
}

async function getSettings() {
  const settingsPath = path.join(__dirname, 'content', 'settings.json');
  const settingsData = await fs.readFile(settingsPath, 'utf-8');
  return JSON.parse(settingsData);
}

app.get('/', async (req, res) => {
  try {
    const services = await getServices();
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
      res.render('booking-form', { service, whatsappNumber: settings.whatsapp_number });
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

app.post('/submit-booking', async (req, res) => {
  try {
    const { service, date, addons } = req.body;
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

    const booking = {
      id: uuidv4(),
      serviceTitle: service,
      date,
      addons: selectedAddons.map(addon => {
        const addonInfo = selectedService.addons.find(a => a.name === addon);
        return { name: addon, price: addonInfo.price };
      }),
      totalPrice,
      status: 'pending'
    };

    // Save booking to JSON file
    await initializeBookingsFile();
    const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
    const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
    const bookings = JSON.parse(bookingsData);
    bookings.push(booking);
    await fs.writeFile(bookingsPath, JSON.stringify(bookings, null, 2));

    // Prepare WhatsApp message
    const settings = await getSettings();
    const whatsappNumber = settings.whatsapp_number;
    const message = `New Booking:
Service: ${service}
Date: ${date}
Addons: ${addonDetails.join(', ') || 'None'}
Total Price: $${totalPrice}`;

    const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;

    res.redirect(whatsappUrl);
  } catch (error) {
    console.error('Error submitting booking:', error);
    res.status(500).render('error', { 
      message: 'An error occurred while submitting the booking',
      error: error
    });
  }
});

app.get('/booking-report', async (req, res) => {
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

// Build CSS before starting the server
exec('npm run build:css', (error, stdout, stderr) => {
  if (error) {
    console.error(`Error building CSS: ${error}`);
    return;
  }
  console.log(`CSS build output: ${stdout}`);
  
  // Start the server after CSS is built
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
});