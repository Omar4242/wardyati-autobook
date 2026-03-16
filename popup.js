document.getElementById('open-tab').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://wardyati.com/rooms/' });
});
