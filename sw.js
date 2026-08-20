// Service Worker para CatálogoZap - Notificações Push & Background Promos
const CACHE_NAME = 'catalogozap-sw-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Manipulador de notificações Push
self.addEventListener('push', (event) => {
    let data = {
        title: 'Nova Promoção Exclusiva! 🔥',
        body: 'Confira as novidades imperdíveis no nosso catálogo!',
        icon: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&q=80&w=200',
        imageUrl: '',
        coupon: '',
        url: '/'
    };

    if (event.data) {
        try {
            const parsed = event.data.json();
            data = { ...data, ...parsed };
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const bannerImg = data.image || data.imageUrl || undefined;

    const options = {
        body: data.body || data.message || '',
        icon: data.icon || 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&q=80&w=200',
        badge: data.icon || 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&q=80&w=200',
        image: bannerImg,
        vibrate: [200, 100, 200, 100, 200],
        data: {
            url: data.url || '/',
            promo: data
        },
        actions: [
            { action: 'open', title: 'Ver Oferta 👀' },
            { action: 'close', title: 'Fechar ❌' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// Clique na notificação
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    if (event.action === 'close') return;

    const notifData = event.notification.data || {};
    const targetUrl = notifData.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if ('focus' in client) {
                    client.focus();
                    client.postMessage({
                        type: 'PROMO_CLICKED',
                        promo: notifData.promo || {
                            title: event.notification.title,
                            message: event.notification.body,
                            imageUrl: event.notification.image
                        }
                    });
                    return;
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

