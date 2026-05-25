export const GAME_SELECTORS = {
  LOGIN: {
    PHONE_INPUT:
      "input.css-89k6i7, input[name='phone'], input[type='tel'], input.css-sfhaz1",
    PASS_INPUT: "input[type='password'], input.css-10zyika",
    SUBMIT_BTN: "button.css-d5jaaj, button[type='submit'], form button",
  },
  GAME: {
    TABLE_BODY: "table.css-1a87jyo tbody",
    BUST_LINK: "table.css-1a87jyo tbody tr.css-15iar3s td span.css-hwpcld",
    // We expect page.$$(GAME.INPUTS) to return [AmountInput, CashoutInput]
    INPUTS:
      "input[type='number'], div.css-1g3l8kd div.css-1633bsf div.css-1xclg2i input.css-10zyika",
    BET_BUTTON: "#tour_bet_button",
    MULTIPLIER_DISPLAY: "#tour_multiplier",
  },
};
