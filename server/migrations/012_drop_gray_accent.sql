-- Gray accent removed from the UI; existing users fall back to the default.
UPDATE users SET accent = 'brick' WHERE accent = 'gray';
