# YouTube Comment Scraper

A professional-grade YouTube comment scraper designed for journalists and researchers. It extracts comments from any public YouTube video and exports them to a structured Excel file.

## Features
- **Video Title as Filename**: Automatically names the output file based on the video title.
- **Dynamic Loading**: Handles YouTube's infinite scroll/dynamic loading efficiently.
- **Structured Data**: Extracts Author, Comment Text, Timestamp, and Like count.
- **Excel Export**: Saves directly to `.xlsx` for easy analysis.

## Prerequisites
- Python 3.8+
- A virtual environment (recommended)

## Installation

1. **Set up a virtual environment**:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

2. **Install dependencies**:
   ```bash
   pip install pandas openpyxl youtube-comment-downloader requests
   ```

## Usage

Run the scraper. By default, it will open a browser window so you can solve any CAPTCHAs manually.

```bash
python youtube_scraper.py "https://www.youtube.com/watch?v=R4P-syCkdMU"
```

### Options:
- **Limit**: To fetch only a few comments: `python youtube_scraper.py "URL" 100`
- **Headless**: To run without a window: `python youtube_scraper.py "URL" --headless`

### Solving CAPTCHAs:
If YouTube detects "unusual traffic":
1. The terminal will pause and alert you.
2. Solve the puzzle in the browser window that opened.
3. Once the video page appears, go back to the terminal and press **ENTER** to start scraping.
