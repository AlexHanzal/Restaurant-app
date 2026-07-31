@echo off
setlocal enabledelayedexpansion

echo Detecting public IP address...
echo.

REM Try multiple services to get public IP
set "ip_found=0"

REM Method 1: Using ipinfo.io
echo Trying ipinfo.io...
for /f "delims=" %%i in ('curl -s ipinfo.io/ip 2^>nul') do (
    if not "%%i"=="" (
        set "public_ip=%%i"
        set "ip_found=1"
        echo Public IP: %%i
        goto :found
    )
)

REM Method 2: Using httpbin.org
echo Trying httpbin.org...
for /f "tokens=2 delims=:" %%i in ('curl -s httpbin.org/ip 2^>nul ^| find "origin"') do (
    for /f "tokens=1 delims=," %%j in ("%%i") do (
        set "temp=%%j"
        set "temp=!temp: =!"
        set "temp=!temp:"=!"
        if not "!temp!"=="" (
            set "public_ip=!temp!"
            set "ip_found=1"
            echo Public IP: !temp!
            goto :found
        )
    )
)

REM Method 3: Using icanhazip.com
echo Trying icanhazip.com...
for /f "delims=" %%i in ('curl -s icanhazip.com 2^>nul') do (
    if not "%%i"=="" (
        set "public_ip=%%i"
        set "ip_found=1"
        echo Public IP: %%i
        goto :found
    )
)

REM Method 4: Using ifconfig.me
echo Trying ifconfig.me...
for /f "delims=" %%i in ('curl -s ifconfig.me 2^>nul') do (
    if not "%%i"=="" (
        set "public_ip=%%i"
        set "ip_found=1"
        echo Public IP: %%i
        goto :found
    )
)

:found
if "%ip_found%"=="0" (
    echo ERROR: Could not detect public IP address.
    echo Please check your internet connection and ensure curl is available.
    pause
    exit /b 1
) else (
    echo.
    echo Your public IP address is: %public_ip%
    echo.
    echo Press any key to exit...
    pause >nul
)

endlocal