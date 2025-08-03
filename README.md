# Google Flights Price Monitor

Automated Google Flights price monitoring system with Supabase integration and push notifications.

## Features

- 🛫 **Flight Price Monitoring**: Automatically extracts flight prices from Google Flights
- 🏗️ **Brazil Configuration**: Pre-configured for Brazil timezone, geolocation (Florianópolis), and Portuguese locale
- 🗄️ **Supabase Integration**: Stores flight data with duplicate detection
- 📱 **Smart Alerts**: Push notifications via Pushcut when prices drop significantly
- 🤖 **Anti-Detection**: Browser configuration to avoid bot detection
- 💰 **Price Analysis**: Compares current prices with historical data

## Installation

1. Clone the repository:
```bash
git clone https://github.com/chrisifm/GoogleFlights.git
cd GoogleFlights
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your Supabase credentials
```

## Environment Variables

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_KEY`: Your Supabase service role key

## Database Schema

The system expects a `flights` table in Supabase with these columns:
- `updated_at` (timestamp)
- `from` (text) - Origin city
- `to` (text) - Destination city  
- `price` (numeric) - Flight price as number
- `currency` (text) - Currency code (e.g., "MX", "USD")
- `link` (text) - Google Flights search URL

## Usage

Run the flight monitor:
```bash
npm start
```

The system will:
1. Open Google Flights with Brazil configuration
2. Extract the first flight price
3. Check for duplicates in the database
4. Insert new price data if unique
5. Send push notification if it's the lowest price with significant savings (+$500 MX vs highest recorded)

## Configuration

### Brazil Settings
- **Location**: Florianópolis, Brazil (-27.5954, -48.5480)
- **Timezone**: America/Sao_Paulo
- **Locale**: pt-BR
- **Viewport**: 980x800

### Alert Conditions
Alerts are sent when BOTH conditions are met:
- Price is the lowest recorded for the route
- Saves at least $500 MX compared to the highest recorded price

## Technologies Used

- **Crawlee**: Web scraping framework with Playwright
- **Playwright**: Browser automation
- **Supabase**: Database and real-time subscriptions
- **Pushcut**: Push notification service

## License

MIT