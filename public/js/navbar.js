// In public/js/navbar.js
document.addEventListener('DOMContentLoaded', function() {
    const navbarToggle = document.getElementById('navbar-toggle');
    const navbarSticky = document.getElementById('navbar-sticky');
  
    navbarToggle.addEventListener('click', function() {
      navbarSticky.classList.toggle('hidden');
    });
  });