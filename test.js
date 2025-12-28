// Test file with intentional issues
function calculateTotal(price, tax) {
    var total = price + tax;  // Using 'var' instead of 'const/let'
    return total;
}

// SECURITY ISSUE: Hardcoded credentials
var username = "admin";
var password = "password123";

// BUG: No check for division by zero
function divide(a, b) {
    return a / b;
}

// INEFFICIENT: Can use Array.map()
var numbers = [1, 2, 3, 4, 5];
var doubled = [];
for (var i = 0; i < numbers.length; i++) {
    doubled.push(numbers[i] * 2);
}

// MISSING: Error handling
function fetchUserData(url) {
    fetch(url)
        .then(response => response.json())
        .then(data => console.log(data));
}

console.log(calculateTotal(100, 20));
console.log(divide(10, 0));  // This will be Infinity!
console.log(doubled);