sudo apt update -y
sudo apt upgrade -y

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22

curl -fsSL https://get.pnpm.io/install.sh | sh -
source /home/ubuntu/.bashrc

sudo apt install python3-pip -y
sudo apt install python3.12-venv -y
