#!/bin/bash
# filepath: /home/stepan/Desktop/project/School-reservation-app-release_1.5/get_public_ip.sh

echo "Detecting public IP address..."
echo

# Initialize variables
ip_found=0
public_ip=""

# Method 1: Using ipinfo.io
echo "Trying ipinfo.io..."
public_ip=$(curl -s ipinfo.io/ip 2>/dev/null)
if [[ -n "$public_ip" && "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    ip_found=1
    echo "Public IP: $public_ip"
else
    # Method 2: Using httpbin.org
    echo "Trying httpbin.org..."
    public_ip=$(curl -s httpbin.org/ip 2>/dev/null | grep -oP '(?<="origin": ")[^"]*')
    if [[ -n "$public_ip" && "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        ip_found=1
        echo "Public IP: $public_ip"
    else
        # Method 3: Using icanhazip.com
        echo "Trying icanhazip.com..."
        public_ip=$(curl -s icanhazip.com 2>/dev/null | tr -d '\n')
        if [[ -n "$public_ip" && "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            ip_found=1
            echo "Public IP: $public_ip"
        else
            # Method 4: Using ifconfig.me
            echo "Trying ifconfig.me..."
            public_ip=$(curl -s ifconfig.me 2>/dev/null)
            if [[ -n "$public_ip" && "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                ip_found=1
                echo "Public IP: $public_ip"
            fi
        fi
    fi
fi

# Display result
if [ "$ip_found" -eq 0 ]; then
    echo "ERROR: Could not detect public IP address."
    echo "Please check your internet connection and ensure curl is installed."
    exit 1
else
    echo
    echo "Your public IP address is: $public_ip"
    echo
fi