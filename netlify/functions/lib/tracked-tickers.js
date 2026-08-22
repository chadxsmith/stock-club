// Full universe of tickers kept polled and warm in the shared store by
// poll-stocks.js. Anything outside this list is a live on-demand Finnhub call,
// which is the path that gets rate-limited — so a ticker missing from here
// shows up in the UI as "out of date".
//
// MUST be a superset of every priceable ticker in episode-mentions.js.
// When a new episode is ingested, re-run the union — the previous drift
// (23 episode tickers unpolled, incl. XLK, XLY, DIS, MRNA, LLY) is exactly
// what this list falling behind the dataset looks like.
module.exports = ["AMD","AMZN","AMKR","AAPL","APLD","ARM","ASML","SQ","BE","AVGO","CDNS","CAT","CLS","CEG","COHR","CORZ","CRWD","DELL","GEV","GNRC","GOOGL","IVZ","INTC","IRM","IREN","JPM","KLAC","LRCX","MA","META","MU","MSFT","NBIS","NFLX","NOK","NVDA","ORCL","PLTR","PANW","RBLX","CRM","WDC","NOW","SOFI","SLDE","SNPS","TSLA","TMUS","TSM","UBS","VRT","V","WMT","WDAY","QQQ","SMH","XLU","COIN","HOOD","IBIT","SNDK","DRAM","SPY","VOO","VTI","STX","FOTO","GLW","JNJ","NKE","ARMG","HIMS","LYTE","NVO","RAM","RSP","SPMO","XLK","XLY","CIEN","LITE","LLY","MRNA","SCHD","SYK","MSTR","SOXX","DIS"];
