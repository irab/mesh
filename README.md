# Meshtastic vs MeshCore Comparison

This is a static site that provides a detailed comparison between Meshtastic and MeshCore, two LoRa mesh networking projects. The site focuses on their routing architectures and performance in disaster scenarios.

## Deployment

This site is designed to be deployed with GitHub Pages. 

To deploy:

1. Push this entire directory to a GitHub repository
2. Go to the repository's Settings tab
3. Navigate to the "Pages" section
4. Select the branch you want to deploy (usually `main` or `master`)
5. Set the folder to `/mesh` or `/`
6. Click "Save"

GitHub will provide you with a URL where the site is published.

## Local Development

To run the site locally:

1. Clone the repository
2. Navigate to the `mesh` directory
3. Open `index.html` in your browser

Alternatively, you can use a local server:

```bash
# Using Python
cd mesh
python -m http.server 8000

# Using Node.js
npm install -g http-server
cd mesh
http-server
```

Then visit `http://localhost:8000` in your browser.

## Structure

- `index.html` - Main comparison overview
- `routing.html` - Interactive D3.js discrete-event LoRa routing & airtime visualization
- `managed-flood.js` - Shared Semtech LoRa PHY/MAC, Meshtastic (`FloodingRouter` / `NextHopRouter`), and MeshCore discrete-event simulation engine
- `technical.html` - Detailed technical & source-code analysis (`Meshtastic v2.6.4 → v2.7.26 / 2.8 develop`, `MeshCore v1.6.0 → v1.18.0`)
- `styles.css` - Shared site styling
- `script.js` - Overview page UI interactions (accordions, smooth scrolling, diagram triggers)

## Content Sources

The content in this site is based on technical analysis of the Meshtastic and MeshCore code repositories, with a focus on the routing architectures and their performance in large-scale disaster scenarios.

## Disclaimer & License

This analysis and interactive simulator are AI-generated for educational and informational purposes only. This project is independent and is not affiliated with, endorsed by, or officially associated with Meshtastic or MeshCore. Meshtastic and MeshCore are separate projects with their own licenses.