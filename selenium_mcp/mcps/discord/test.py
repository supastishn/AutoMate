from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service # <-- Make sure to import Service

# -- Set Firefox to run in headless mode --
firefox_options = Options()
firefox_options.add_argument("--headless")

# -- Explicitly define the path to geckodriver --
# As you correctly found, we need to specify the path.
driver_path = "/usr/bin/geckodriver"
service = Service(executable_path=driver_path)

try:
    # -- Initialize the Firefox driver with the specific service and options --
    print("Initializing Firefox driver...")
    browser = webdriver.Firefox(options=firefox_options, service=service)

    # -- Navigate to a website --
    url = "http://www.google.com"
    print(f"Navigating to {url}...")
    browser.get(url)

    # -- Print the page title to confirm --
    print(f"The page title is: {browser.title}")

    # -- Take a screenshot --
    browser.save_screenshot("screenshot.png")
    print("Screenshot saved as screenshot.png")
    print("Script finished successfully.")

except Exception as e:
    print(f"An error occurred: {e}")

finally:
    # -- Close the browser --
    if 'browser' in locals() and browser:
        browser.quit()
