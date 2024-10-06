const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const markdown = require('markdown-it')();
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
      if (path.extname(file).toLowerCase() === '.md') {
        const filePath = path.join(servicesDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const service = parseServiceMarkdown(content);
        services.push(service);
      }
    }

    console.log('Parsed services:', services);
    return services;
  } catch (error) {
    console.error('Error reading services:', error);
    return [];
  }
}

function parseServiceMarkdown(content) {
  const lines = content.split('\n');
  const service = {
    title: '',
    description: '',
    price: 0,
    thumbnail: '',
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

  console.log('Parsed service:', service);
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
    console.log('Services to be rendered:', services);
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
      console.log('Service for booking form:', service);
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
    const { service, date, addons, options, name, whatsappNumber, email } = req.body;
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

    const booking = {
      id: uuidv4(),
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
    await initializeBookingsFile();
    const bookingsPath = path.join(__dirname, 'data', 'bookings.json');
    const bookingsData = await fs.readFile(bookingsPath, 'utf-8');
    const bookings = JSON.parse(bookingsData);
    bookings.push(booking);
    await fs.writeFile(bookingsPath, JSON.stringify(bookings, null, 2));

    // Prepare WhatsApp message
    const settings = await getSettings();
    const businessWhatsappNumber = settings.whatsapp_number;
    const message = `New Booking:
Name: ${name}
WhatsApp: ${whatsappNumber}
Email: ${email}
Service: ${service}
Date: ${date}
Addons: ${addonDetails.join(', ') || 'None'}
Options: ${Object.entries(options).map(([key, value]) => `${key}: ${value}`).join(', ')}
Total Price: $${totalPrice}`;

    const whatsappUrl = `https://wa.me/${businessWhatsappNumber}?text=${encodeURIComponent(message)}`;

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