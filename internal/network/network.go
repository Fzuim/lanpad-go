// Package network discovers the LAN addresses a teammate can use.
package network

import (
	"net"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Address is one non-loopback private IPv4 interface.
type Address struct {
	Iface   string `json:"iface"`
	Address string `json:"address"`
	URL     string `json:"url"`
}

// Info is the payload of GET /api/network.
type Info struct {
	Primary        string    `json:"primary"`
	PrimaryAddress string    `json:"primaryAddress"`
	Addresses      []Address `json:"addresses"`
}

var privateIPv4 = regexp.MustCompile(`^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)`)

var virtualInterface = regexp.MustCompile(`(?i)vethernet|vmware|virtualbox|tailscale|zerotier|docker|wsl`)
var physicalInterface = regexp.MustCompile(`(?i)^(wi-?fi|wlan|ethernet|以太网|无线)`)

// Discover returns the preferred base URL plus every candidate address.
// PUBLIC_BASE_URL overrides automatic detection when non-empty.
func Discover(port int, publicBaseURL string) Info {
	addresses := ListPrivateIPv4(port)
	if publicBaseURL != "" {
		return Info{
			Primary:        publicBaseURL,
			PrimaryAddress: hostFromBase(publicBaseURL),
			Addresses:      addresses,
		}
	}

	routeIP := defaultRouteIPv4()
	if len(addresses) == 0 {
		return Info{
			Primary:        "http://127.0.0.1:" + strconv.Itoa(port),
			PrimaryAddress: "127.0.0.1",
			Addresses:      addresses,
		}
	}
	preferred := addresses[0]
	for _, item := range addresses {
		if item.Address == routeIP {
			preferred = item
			break
		}
	}
	return Info{
		Primary:        preferred.URL,
		PrimaryAddress: preferred.Address,
		Addresses:      addresses,
	}
}

// ListPrivateIPv4 enumerates private IPv4 addresses, preferring physical
// Wi-Fi/Ethernet adapters and demoting virtual ones.
func ListPrivateIPv4(port int) []Address {
	out := make([]Address, 0, 4)
	interfaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || ip.IsLoopback() {
				continue
			}
			text := ip.String()
			if !privateIPv4.MatchString(text) {
				continue
			}
			out = append(out, Address{
				Iface:   iface.Name,
				Address: text,
				URL:     "http://" + text + ":" + strconv.Itoa(port),
			})
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := rankInterface(out[i].Iface), rankInterface(out[j].Iface)
		if ri != rj {
			return ri < rj
		}
		return out[i].Address < out[j].Address
	})
	return out
}

func rankInterface(name string) int {
	lower := strings.ToLower(name)
	switch {
	case physicalInterface.MatchString(lower):
		return 0
	case virtualInterface.MatchString(lower):
		return 2
	default:
		return 1
	}
}

// defaultRouteIPv4 asks the OS which local IP would reach the internet by
// "connecting" a UDP socket (no packet is sent).
func defaultRouteIPv4() string {
	conn, err := net.DialTimeout("udp4", "223.5.5.5:53", 800*time.Millisecond)
	if err != nil {
		return ""
	}
	defer conn.Close()
	udp, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return ""
	}
	return udp.IP.String()
}

func hostFromBase(base string) string {
	if parsed, err := url.Parse(base); err == nil && parsed.Hostname() != "" {
		return parsed.Hostname()
	}
	withoutScheme := regexp.MustCompile(`^https?://`).ReplaceAllString(base, "")
	if host, _, err := net.SplitHostPort(withoutScheme); err == nil {
		return host
	}
	return withoutScheme
}
