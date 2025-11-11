// routes/store.js
const stripeLib = require('stripe');
const nodemailer = require('nodemailer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Config = require('../models/Config');

module.exports = function(getEmailConfig, app) {
  const router = require('express').Router();

  let transporter;

  // FIXED: createTransporter → createTransport
  async function createTransporter() {
    const cfg = await getEmailConfig();  // Wait for promise
    if (!cfg?.emailUser || !cfg?.emailPass) {
      console.error('EMAIL CONFIG MISSING:', cfg);
      return;
    }

    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: cfg.emailUser,
        pass: cfg.emailPass
      }
    });

    console.log('Transporter refreshed with:', cfg.emailUser);
  }

  // Initial setup + force reload after DB is ready
  createTransporter();

  // Expose for admin to refresh
  router.createTransporter = createTransporter;

  // Home
  router.get('/', async (req, res) => {
    const products = await Product.find();
    res.render('index', { products, cart: req.session.cart || [] });
  });

  // Add to Cart
  router.post('/add-to-cart/:id', async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/');

    if (!req.session.cart) req.session.cart = [];
    const existing = req.session.cart.find(i => i.id === req.params.id);
    if (existing) {
      existing.quantity += 1;
    } else {
      req.session.cart.push({
        id: product._id,
        name: product.name,
        price: product.price,
        quantity: 1
      });
    }
    res.redirect('/');
  });

  // Cart
  router.get('/cart', (req, res) => {
    const cart = req.session.cart || [];
    const total = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    res.render('cart', { cart, total });
  });

  // Checkout
  router.post('/checkout', async (req, res) => {
    const cfg = await getEmailConfig();  // Await
    const config = await Config.findOne();

    if (!config?.stripeSecretKey) {
      return res.status(500).send('Stripe not configured');
    }

    const stripe = stripeLib(config.stripeSecretKey);
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.redirect('/cart');

    const totalCents = cart.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100;

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: cart.map(item => ({
          price_data: {
            currency: 'gbp',  // UK client
            product_data: { name: item.name },
            unit_amount: Math.round(item.price * 100)
          },
          quantity: item.quantity
        })),
        mode: 'payment',
        success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.protocol}://${req.get('host')}/cart`
      });

      const order = new Order({
        items: cart.map(i => ({ product: i.id, quantity: i.quantity })),
        total: totalCents / 100,
        email: req.body.email,
        stripeSessionId: session.id
      });
      await order.save();

      // Refresh transporter before sending
      await createTransporter();

      // Buyer Email
      await transporter.sendMail({
        from: cfg.emailUser,
        to: req.body.email,
        subject: 'Order Received - Urban Solz',
        html: `
          <h3>Order #${order._id}</h3>
          <p>Total: £${order.total.toFixed(2)}</p>
          <p>Thank you! We'll process your order shortly.</p>
          <p><a href="${req.protocol}://${req.get('host')}/order/confirm/${order._id}">Confirm</a> | 
             <a href="${req.protocol}://${req.get('host')}/order/cancel/${order._id}">Cancel</a></p>
        `
      });

      // Owner Alert
      await transporter.sendMail({
        from: cfg.emailUser,
        to: cfg.sellerEmail,
        subject: `New Order #${order._id} - £${order.total.toFixed(2)}`,
        text: `Customer: ${req.body.email} | Items: ${cart.map(i => i.name).join(', ')} | Session: ${session.id}`
      });

      res.redirect(303, session.url);
    } catch (err) {
      console.error('Checkout error:', err);
      res.status(500).send('Payment failed. Try again.');
    }
  });

  // Success
  router.get('/success', async (req, res) => {
    const config = await Config.findOne();
    if (!config?.stripeSecretKey || !req.query.session_id) {
      return res.render('success', { message: 'Payment processed.' });
    }

    const stripe = stripeLib(config.stripeSecretKey);
    try {
      const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
      if (session.payment_status === 'paid') {
        req.session.cart = [];
        res.render('success', { message: 'Payment successful! Order confirmed.' });
      } else {
        res.render('success', { message: 'Payment pending. Check email.' });
      }
    } catch (err) {
      res.render('success', { message: 'Payment processed.' });
    }
  });

  // Confirm Order
  router.get('/order/confirm/:id', async (req, res) => {
    const cfg = await getEmailConfig();
    const order = await Order.findById(req.params.id);
    if (!order || order.status !== 'Pending') return res.send('<h1>Invalid Link</h1>');

    order.status = 'Confirmed';
    await order.save();

    await createTransporter();
    await transporter.sendMail({
      from: cfg.emailUser,
      to: cfg.sellerEmail,
      subject: `Order CONFIRMED #${order._id}`,
      text: `Customer ${order.email} confirmed their order.`
    });

    res.send('<h1>Order Confirmed!</h1><p>Thank you. We\'re processing your order.</p><a href="/">Continue Shopping</a>');
  });

  // Cancel Order
  router.get('/order/cancel/:id', async (req, res) => {
    const cfg = await getEmailConfig();
    const order = await Order.findByIdAndUpdate(req.params.id, { status: 'Cancelled' });
    if (!order) return res.send('<h1>Invalid Link</h1>');

    const config = await Config.findOne();
    const stripe = stripeLib(config.stripeSecretKey);

    try {
      const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
      if (session.payment_status === 'paid' && session.payment_intent) {
        await stripe.refunds.create({ payment_intent: session.payment_intent });
      }
    } catch (e) {
      console.error('Refund failed:', e);
    }

    await createTransporter();
    await transporter.sendMail({
      from: cfg.emailUser,
      to: cfg.sellerEmail,
      subject: `Order CANCELLED #${order._id}`,
      text: `Customer ${order.email} cancelled. Refund issued if paid.`
    });

    res.send('<h1>Order Cancelled</h1><p>Full refund issued.</p><a href="/">Shop More</a>');
  });

  return router;
};
