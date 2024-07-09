const dotenv = require('dotenv');
const axios = require('axios');
const cron = require('node-cron');

dotenv.config();

const SITES = process.env.SITES;

const INTERVAL = process.env.INTERVAL || '30';
const NERVOUS_INTERVAL = process.env.NERVOUS_INTERVAL || '1';
const CRON_ALIVE_SELF = process.env.CRON_ALIVE_SELF || '0 9 * * 1';
const STRICT_DOWN_CHECK = process.env.STRICT_DOWN_CHECK || 'false';

const BOT_TOKEN = process.env.BOT_TOKEN || 'your_telegram_bot_token';
const CHAT_ID = process.env.CHAT_ID || 'your_telegram_chat_id';

const TEMPLATE_DOWN = process.env.TEMPLATE_DOWN || '🔴 {site} is down!';
const TEMPLATE_UP = process.env.TEMPLATE_UP || '🟢 {site} is up again!';
const TEMPLATE_ALIVE_SELF = process.env.TEMPLATE_ALIVE_SELF || "🔵 I'm alive and well!";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

const sites = (SITES || '').split(',');
console.log('Checking Sites:', sites);

const sitesKnownToBeDown = new Set();
const strictDownCheck = STRICT_DOWN_CHECK === 'true';

if (!sites.length) {
    console.error('No sites to check!');
    process.exit(1);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~

/**
 * Send a message to the Telegram chat
 * @param {*} message Message to send
 * @param {*} params Additional parameters to send to the Telegram API
 */
async function sendTelegramMessage(message, params = {}) {
    try {
        await axios.post(TELEGRAM_API, {
            chat_id: CHAT_ID,
            text: message,
            ...params,
        });
    } catch (error) {
        console.error('Error sending message:', error);
    }
};

/**
 * Check if a site is up. If strictDownCheck is enabled, we will not consider a site down if we get a 3xx, 4xx, or 5xx status code.
 * @param {*} site Site to check
 * @returns true if the site is up, false otherwise
 */
async function checkSite(site) {
    try {
        await axios.get(site, { timeout: 5000 });
        return true;
    } catch (error) {
        // strictDownCheck: If we get a 300, 400, or 500 status code, the site is not offline
        if (strictDownCheck && error.response && error.response.status >= 300 && error.response.status < 600) {
            return true;
        }

        return false;
    }
};

/**
 * Check multiple sites at once.
 * @param {*} sitesToCheck Sites to check
 * @returns Array of objects { site: site, isUp: true/false }
 * @see checkSite for more information on the isUp field
 */
async function checkSites(sitesToCheck) {
    const results = await Promise.all(sitesToCheck.map(async (site) => {
        const isUp = await checkSite(site);
        return {
            site,
            isUp,
        };
    }));

    return results;
};

/**
 * Send a message for each site in the list, using the template provided.
 * @param {*} sites List of sites to send a message for
 * @param {*} template Template to use for the message. Use {site} to replace with the site name.
 * @returns Promise
 */
async function sendMessageForSites(sites, template) {
    if (!sites) {
        return;
    }

    const messages = sites.map((site) => template.replace('{site}', site));
    await sendTelegramMessage(messages.join('\n'));
}

// ~~~~~~~~~~~~~~~~~~~~~~~~ Site Notification Logic ~~~~~~~~~~~~~~~~~~~~~~~~
/**
 * Notify about sites that went down, based on the results of the check passed.
 * Also add the downed sites to the set of sites known to be down.
 * @param {*} results Results of the check
 * @returns Promise
 */
async function notifyAboutSitesThatWentDown(results) {
    // Check if sites that were supposed to be up are now down
    const newDownSites = results.filter((result) => !result.isUp).map((result) => result.site);

    // If there are no new down sites, nothing to do
    if (!newDownSites.length) {
        return;
    }

    // Add new down sites to the set
    newDownSites.forEach((site) => sitesKnownToBeDown.add(site));

    // Notify that sites went down
    await sendMessageForSites(newDownSites, TEMPLATE_DOWN);
}

/**
 * Notify about sites that went up, based on the results of the check passed.
 * Also remove the up sites from the set of sites known to be down.
 * @param {*} results Results of the check
 * @returns Promise
 */
async function notifyAboutSidesThatWentUp(results) {
    // Check if sites that were down are now up
    const newUpSites = results.filter((result) => result.isUp).map((result) => result.site);

    // If there are no new up sites, nothing to do
    if (!newUpSites.length) {
        return;
    }

    // Remove up sites from the set
    newUpSites.forEach((site) => sitesKnownToBeDown.delete(site));

    // Notify that sites went up
    return sendMessageForSites(newUpSites, TEMPLATE_UP);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~ Scheduled Functions ~~~~~~~~~~~~~~~~~~~~~~~~

/**
 * Check all sites that are not known to be down and notify if any of them went down.
 * This function is scheduled to run every INTERVAL minutes.
 * @returns Promise
 * @see notifyAboutSitesThatWentDown for more information on the notification logic
 */
async function checkSitesAndNotify() {
    console.log(`Checking sites...`);
    const sitesToCheck = sites.filter((site) => !sitesKnownToBeDown.has(site));
    const results = await checkSites(sitesToCheck);

    await notifyAboutSitesThatWentDown(results);
}

// Every interval, check all sites that are not known to be down
console.log(`Checking sites every ${INTERVAL} minutes. Next check is at ${new Date(Date.now() + 1000 * 60 * INTERVAL)}`);
cron.schedule(`*/${INTERVAL} * * * *`, checkSitesAndNotify);

/**
 * Check all sites that are known to be down and notify if any of them went up.
 * This function is scheduled to run every NERVOUS_INTERVAL minutes.
 * @returns Promise
 * @see notifyAboutSidesThatWentUp for more information on the notification logic
 */
async function checkSitesKnownToBeDown() {
    console.log(`Checking sites known to be down...`);
    const sitesToCheck = Array.from(sitesKnownToBeDown);
    const results = await checkSites(sitesToCheck);
    await notifyAboutSidesThatWentUp(results);
}

// Every nervous interval, check all sites that are known to be down
console.log(`Checking sites known to be down every ${NERVOUS_INTERVAL} minutes. Next check is at ${new Date(Date.now() + 1000 * 60 * NERVOUS_INTERVAL)}`);
cron.schedule(`*/${NERVOUS_INTERVAL} * * * *`, checkSitesKnownToBeDown);

// Notify that the service itself is alive
if (!cron.validate(CRON_ALIVE_SELF)) {
    console.error('Invalid CRON_ALIVE_SELF format. Ignoring self-alive notification.');
} else {
    console.log(`Notifying that the service is alive every: ${CRON_ALIVE_SELF}`);
    cron.schedule(CRON_ALIVE_SELF, async () => {
        console.log(`Notifying that the service is alive...`);
        await sendTelegramMessage(TEMPLATE_ALIVE_SELF);
    });
}

// Initial checks
checkSitesAndNotify();
checkSitesKnownToBeDown();
