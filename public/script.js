// ===============================
// ISU Shop - script.js
// Cart + Favorites + Product Render + Checkout (Mollie)
// ===============================

// ---- State (localStorage) ----
let cart = JSON.parse(localStorage.getItem("cart")) || [];
let favorites = JSON.parse(localStorage.getItem("favorites")) || [];

function saveCart(){ localStorage.setItem("cart", JSON.stringify(cart)); updateBadges(); }
function saveFavorites(){ localStorage.setItem("favorites", JSON.stringify(favorites)); updateBadges(); }

// ---- Badges (header counters) ----
function updateBadges(){
  const cartCount = document.getElementById("cartCount");
  const favCount = document.getElementById("favCount");
  if(cartCount) cartCount.textContent = cart.reduce((s,i)=>s+i.quantity,0);
  if(favCount) favCount.textContent = favorites.length;
}

// ---- Cart ----
function addToCart(product){
  const exists = cart.find(i => i.id === product.id);
  if (exists) exists.quantity += 1; else cart.push({ ...product, quantity: 1 });
  saveCart(); renderCart();
}
function removeFromCart(id){
  cart = cart.filter(i => i.id !== id);
  saveCart(); renderCart();
}
function updateQuantity(id, qty){
  const item = cart.find(i => i.id === id);
  if(!item) return;
  item.quantity = qty;
  if(item.quantity <= 0) removeFromCart(id);
  saveCart(); renderCart();
}
function renderCart(){
  const list = document.getElementById("cart-items");
  const totalEl = document.getElementById("cart-total");
  if(!list || !totalEl) return;

  list.innerHTML = "";
  let total = 0;
  cart.forEach(it => {
    total += it.price * it.quantity;
    const li = document.createElement("li");
    li.className = "cart-item";
    li.innerHTML = `
      <div>
        <div><strong>${escapeHtml(it.name)}</strong></div>
        <div class="small">€${it.price.toFixed(2)}</div>
      </div>
      <div class="qty">
        <button onclick="updateQuantity(${it.id}, ${it.quantity-1})">-</button>
        <span>${it.quantity}</span>
        <button onclick="updateQuantity(${it.id}, ${it.quantity+1})">+</button>
        <button onclick="removeFromCart(${it.id})">🗑️</button>
      </div>
    `;
    list.appendChild(li);
  });
  totalEl.textContent = "Total: €" + total.toFixed(2);
  updateBadges();
}

// ---- Favorites ----
function isFav(id){ return favorites.some(f => f.id === id); }
function toggleFavorite(product){
  if(isFav(product.id)){
    favorites = favorites.filter(f => f.id !== product.id);
  } else {
    favorites.push(product);
  }
  saveFavorites();
  renderFavorites();
}
function renderFavorites(){
  const container = document.getElementById("favorites-list");
  if(!container) return;
  container.innerHTML = "";

  if(favorites.length === 0){
    container.innerHTML = `<div class="card"><p>No favorites yet. ⭐ Add some from the shop.</p></div>`;
    return;
  }

  favorites.forEach(p => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <img src="${p.image || ''}" alt="">
      <h3>${escapeHtml(p.name)}</h3>
      <div class="row">
        <div class="price">€${p.price.toFixed(2)}</div>
        <div>
          <button class="btn" onclick='addToCart(${JSON.stringify(p)})'>Add to Cart</button>
          <button class="btn ghost" onclick='toggleFavorite(${JSON.stringify(p)})'>Unstar</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

// ---- Products (Shop) ----
async function loadProducts(){
  const grid = document.getElementById("productGrid");
  if(!grid) return;

  grid.innerHTML = `<div class="card">Loading...</div>`;
  try{
    const res = await fetch("/api/products");
    const products = await res.json();

    grid.innerHTML = "";
    products.forEach(p => {
      const product = {
        id: p.id,
        name: p.title,
        price: Number(p.price),
        image: p.image || ""
      };
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <img src="${product.image}" alt="">
        <h3>${escapeHtml(product.name)}</h3>
        <div class="row">
          <div class="price">€${product.price.toFixed(2)}</div>
          <div>
            <button class="btn" onclick='addToCart(${JSON.stringify(product)})'>🛒</button>
            <button class="btn ghost" onclick='toggleFavorite(${JSON.stringify(product)})'>⭐</button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  }catch(e){
    grid.innerHTML = `<div class="card">Failed to load products.</div>`;
  }
}

// ---- Checkout (Mollie only) ----
async function checkout(){
  if(cart.length === 0){ alert("Your cart is empty."); return; }
  const email = prompt("Enter your email for receipt:"); 
  if(!email) return;

  const items = cart.map(i => ({ id: i.id, quantity: i.quantity }));

  const resp = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, customer_email: email, provider: "mollie" })
  });

  const data = await resp.json();
  if (data.url) {
    window.location = data.url; // Mollie hosted checkout
  } else {
    alert("Checkout failed: " + (data.error || "Unknown error"));
  }
}

// ---- UI: cart drawer + init ----
function openDrawer(){ const d=document.getElementById("cartDrawer"); if(d){ d.classList.add("open"); d.setAttribute("aria-hidden","false"); } }
function closeDrawer(){ const d=document.getElementById("cartDrawer"); if(d){ d.classList.remove("open"); d.setAttribute("aria-hidden","true"); } }

function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

document.addEventListener("DOMContentLoaded", () => {
  const openBtn = document.getElementById("openCartBtn");
  const closeBtn = document.getElementById("closeCartBtn");
  if(openBtn) openBtn.addEventListener("click", openDrawer);
  if(closeBtn) closeBtn.addEventListener("click", closeDrawer);

  updateBadges();
  renderCart();
  renderFavorites();
  loadProducts();
});
