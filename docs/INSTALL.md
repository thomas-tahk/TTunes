# Install TTunes on a new Mac

Do each step in order. Paste the commands into the Terminal app (press Cmd+Space, type `Terminal`, press Enter).

## 1. Install Homebrew (one time)

Paste this, press Enter, and follow the prompts (it asks for your Mac password):

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

When it finishes, it prints "Next steps" with two commands. Paste those too, then close and reopen Terminal.

## 2. Install the tools TTunes needs

```
brew install node yt-dlp ffmpeg
```

## 3. Download TTunes

```
git clone https://github.com/thomas-tahk/TTunes.git
```

(If a window offers to install "command line developer tools", click Install and wait, then paste the line again.)

## 4. Start it

Open the new `TTunes` folder in Finder (it is in your home folder) and double-click **Start TTunes**.

The first time, macOS may say it is from an "unidentified developer" or cannot be opened. That is expected:

1. Right-click (or Control-click) **Start TTunes**.
2. Choose **Open**.
3. Click **Open** in the box that appears.

You only do this once. If Terminal says "permission denied" instead, paste: `chmod +x ~/TTunes/"Start TTunes.command"`

The first start takes a minute or two (it sets itself up). Then your browser opens TTunes at http://localhost:8787.

## Using it every day

- **Start:** double-click **Start TTunes**. If it is already running, it just opens the browser.
- **Stop:** close the Terminal window ("TTunes is running" window).
- Songs are stored inside the TTunes folder: audio in `uploads/`, the song list in `data/`. Copy those two folders to back up your music.

## Update to the latest version

```
cd ~/TTunes
git pull
```

Then double-click **Start TTunes** as usual. It rebuilds itself when needed.

## If something is missing

The Start window prints a warning if `yt-dlp` or `ffmpeg` is missing (adding from YouTube won't work). Fix with:

```
brew install yt-dlp ffmpeg
```
