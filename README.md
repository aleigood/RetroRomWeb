## ⚙️ Installation & Setup

1. **Clone the repository**
   ```bash
   git clone [https://github.com/YourName/RetroRomWeb.git](https://github.com/YourName/RetroRomWeb.git)
   cd RetroRomWeb

```

2. **Install dependencies**
```bash
npm install

```


3. **Configure the application**
* Copy `config.example.js` to `config.js`.
* Edit `config.js` and fill in your ScreenScraper credentials.


```bash
cp config.example.js config.js

```


4. **Add your ROMs**
* Put your game files into the `roms/` folder (organized by system, e.g., `roms/nes/mario.zip`).


5. **Start the server**
```bash
node app.js
# or
npm start

```